import { many, maybeOne, one, type Db } from '../../db/client';
import { addDays, shortDate } from '../../lib/dates';
import { fromMinor } from '../../lib/money';
import { normName } from '../../lib/text';
import type { LedgerContext } from '../../ledger/context';
import type { VoucherInputRaw } from '../../ledger/contracts';
import type { Statement, StatementLine } from './statement';
import type { Proposal, Suggestion } from './entries';

export type Direction = 'IN' | 'OUT';
export const direction = (l: StatementLine): Direction => (l.creditMinor > 0n ? 'IN' : 'OUT');
export const lineAmount = (l: StatementLine) => (l.creditMinor > 0n ? l.creditMinor : l.debitMinor);

// Generic banking words carry no meaning for "who/what was this".
const NOISE = new Set(['upi', 'neft', 'imps', 'rtgs', 'ref', 'refno', 'txn', 'trf', 'transfer', 'by', 'to', 'from', 'inb', 'mob', 'chq', 'cheque',
  'ach', 'dr', 'cr', 'nach', 'ecs', 'payment', 'paid', 'received', 'credit', 'debit', 'ib', 'fund', 'funds', 'tpt', 'clg', 'clearing', 'inward',
  'outward', 'mmt', 'bil', 'onl', 'pos', 'ecom', 'p2a', 'p2m', 'yesb', 'hdfc', 'icic', 'sbin', 'utib', 'kkbk', 'pytm', 'okaxis', 'okhdfcbank', 'oksbi', 'ybl', 'paytm']);

/** "UPI/412345678901/RAJESH TRADERS/rajesh@okhdfc/Payment" -> "rajesh traders": the stable part of a narration. */
export function narrationPattern(narration: string): string {
  return narration.toLowerCase()
    .replace(/[/|\\-]+/g, ' ')            // UPI/NEFT fields are slash- or dash-separated
    .replace(/\S+@\S+/g, ' ')
    .replace(/[^a-z ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !NOISE.has(w))
    .join(' ')
    .slice(0, 120)
    .trim();
}

interface Rule { re: RegExp; dir: Direction | 'ANY'; ledger: 'CASH' | string[]; reason: string; create?: { name: string; group: string } }

/** Patterns that hold for almost every Indian bank statement. Ledger names are tried in order. */
const RULES: Rule[] = [
  { re: /\b(atm|cash wdl|cash withdrawal|cash withdrawn|self)\b/i, dir: 'OUT', ledger: 'CASH', reason: 'Cash withdrawal' },
  { re: /\b(cash dep|cash deposit|by cash|cdm|cash cr)\b/i, dir: 'IN', ledger: 'CASH', reason: 'Cash deposit' },
  { re: /\b(chrg|chg|charges|sms alert|amc|commission|service fee|processing fee|annual fee|min bal|gst on)\b/i, dir: 'OUT', ledger: ['bank charges'], reason: 'Bank charges', create: { name: 'Bank Charges', group: 'INDIRECT_EXPENSES' } },
  { re: /\b(int pd|int\.pd|interest|int cr|sb int|int on)\b/i, dir: 'IN', ledger: ['bank interest', 'interest received', 'interest income'], reason: 'Interest from bank', create: { name: 'Bank Interest', group: 'INDIRECT_INCOMES' } },
  { re: /\b(salary|salaries|wages|payroll)\b/i, dir: 'OUT', ledger: ['salaries', 'salary', 'wages'], reason: 'Salary' },
  { re: /\b(rent)\b/i, dir: 'OUT', ledger: ['rent'], reason: 'Rent' },
  { re: /\b(electricity|eb bill|tneb|tangedco|bescom|msedcl|mseb|bses|tata power|cesc|kseb|apspdcl|tsspdcl)\b/i, dir: 'OUT', ledger: ['electricity', 'electricity charges', 'power'], reason: 'Electricity bill' },
  { re: /\b(airtel|jio|bsnl|vodafone|vi postpaid|act fibernet|broadband|telephone|mobile bill)\b/i, dir: 'OUT', ledger: ['telephone & internet', 'telephone', 'internet'], reason: 'Phone / internet' },
  { re: /\b(petrol|diesel|fuel|hpcl|iocl|bpcl|indian oil|bharat petroleum|hindustan petroleum)\b/i, dir: 'OUT', ledger: ['fuel', 'vehicle fuel', 'petrol'], reason: 'Fuel' },
];

export interface BankContext {
  ctx: LedgerContext;
  bankLedgerId: string;
  /** Vouchers already matched to a line of this document, so two lines can't claim the same one. */
  claimed: Set<string>;
}

/** Finds a voucher already in the books for this line (same amount on the bank ledger within 3 days). */
const TYPE_WORD: Record<string, string> = { RECEIPT: 'Receipt', PAYMENT: 'Payment', CONTRA: 'Contra', JOURNAL: 'Journal', SALES: 'Sales', PURCHASE: 'Purchase', CREDIT_NOTE: 'Credit Note', DEBIT_NOTE: 'Debit Note' };

async function findInBooks(db: Db, b: BankContext, l: StatementLine): Promise<{ voucherId: string; voucherNo: string; voucherType: string; date: string } | null> {
  const signed = l.creditMinor > 0n ? l.creditMinor : -l.debitMinor;
  const rows = await many<{ voucher_id: string; voucher_no: string; voucher_type: string; date: string }>(db,
    `SELECT e.voucher_id, v.voucher_no, vt.base_type AS voucher_type, e.voucher_date::text AS date
       FROM ledger_entries e JOIN vouchers v ON v.id = e.voucher_id JOIN voucher_types vt ON vt.id = v.voucher_type_id
      WHERE e.company_id = $1 AND e.ledger_id = $2 AND e.amount_minor = $3
        AND e.voucher_date BETWEEN $4 AND $5
        AND v.reverses_voucher_id IS NULL AND NOT EXISTS (SELECT 1 FROM vouchers r WHERE r.reverses_voucher_id = v.id)
      ORDER BY abs(e.voucher_date - $6::date), v.chain_seq`,
    [b.ctx.company.id, b.bankLedgerId, signed, addDays(l.date, -3), addDays(l.date, 3), l.date]);
  const hit = rows.find((r) => !b.claimed.has(r.voucher_id));
  if (hit) b.claimed.add(hit.voucher_id);
  return hit ? { voucherId: hit.voucher_id, voucherNo: hit.voucher_no, voucherType: hit.voucher_type, date: hit.date } : null;
}

async function ledgerByNames(db: Db, companyId: string, names: string[]): Promise<{ id: string; name: string } | null> {
  return maybeOne(db, `SELECT id, name FROM ledgers WHERE company_id = $1 AND lower(name) = ANY($2::text[]) AND is_active ORDER BY array_position($2::text[], lower(name)) LIMIT 1`, [companyId, names]);
}

/** Creates a commonly needed ledger (Bank Charges, Bank Interest) the first time a statement needs it. */
async function ensureLedger(db: Db, companyId: string, name: string, groupCode: string): Promise<{ id: string; name: string }> {
  const existing = await ledgerByNames(db, companyId, [name.toLowerCase()]);
  if (existing) return existing;
  const g = await one<{ id: string }>(db, `SELECT id FROM ledger_groups WHERE company_id = $1 AND system_code = $2`, [companyId, groupCode]);
  return one(db, `INSERT INTO ledgers (company_id, group_id, name, norm_name) VALUES ($1,$2,$3,$4) RETURNING id, name`, [companyId, g.id, name, normName(name)]);
}

/** Learned rule: the reviewer picked this ledger for a similar narration before. */
async function learnedRule(db: Db, companyId: string, dir: Direction, pattern: string) {
  if (!pattern) return null;
  return maybeOne<{ ledger_id: string; name: string; score: number }>(db,
    `SELECT r.ledger_id, l.name, similarity(r.pattern, $3)::float8 AS score
       FROM narration_rules r JOIN ledgers l ON l.id = r.ledger_id
      WHERE r.company_id = $1 AND r.direction = $2 AND l.is_active AND similarity(r.pattern, $3) >= 0.6
      ORDER BY score DESC, r.hits DESC LIMIT 1`, [companyId, dir, pattern]);
}

export async function learnNarration(db: Db, companyId: string, narration: string, dir: Direction, ledgerId: string) {
  const pattern = narrationPattern(narration);
  if (pattern.length < 3) return;
  await db.query(
    `INSERT INTO narration_rules (company_id, pattern, direction, ledger_id) VALUES ($1,$2,$3,$4)
     ON CONFLICT (company_id, pattern, direction) DO UPDATE SET ledger_id = EXCLUDED.ledger_id,
       hits = CASE WHEN narration_rules.ledger_id = EXCLUDED.ledger_id THEN narration_rules.hits + 1 ELSE 1 END, updated_at = now()`,
    [companyId, pattern, dir, ledgerId]);
}

/** A party whose name appears in the narration; debtors for money in, creditors for money out. */
async function partyInNarration(db: Db, b: BankContext, l: StatementLine, dir: Direction) {
  const text = normName(l.narration);
  if (!text) return null;
  const group = dir === 'IN' ? 'sundry_debtors' : 'sundry_creditors';
  const rows = await many<{ ledger_id: string; name: string; score: number; group_ok: boolean }>(db,
    `SELECT l.id AS ledger_id, c.legal_name AS name, word_similarity(c.norm_name, $2)::float8 AS score,
            (g.path::text LIKE '%' || $3 || '%') AS group_ok
       FROM counterparties c JOIN ledgers l ON l.counterparty_id = c.id JOIN ledger_groups g ON g.id = l.group_id
      WHERE c.company_id = $1 AND c.status <> 'INACTIVE' AND length(c.norm_name) >= 4 AND word_similarity(c.norm_name, $2) >= 0.8
      ORDER BY group_ok DESC, score DESC LIMIT 2`, [b.ctx.company.id, text, group]);
  if (!rows.length) return null;
  // Two equally good parties (Rajesh vs Rakesh) -> don't guess.
  if (rows[1] && Math.abs(rows[0].score - rows[1].score) < 0.05 && rows[0].group_ok === rows[1].group_ok) return null;
  return rows[0];
}

/** An open bill of this party for exactly this amount: the payment settles that bill. */
async function matchingBill(db: Db, companyId: string, ledgerId: string, amount: bigint, dir: Direction): Promise<string | null> {
  const want = dir === 'IN' ? amount : -amount;
  const r = await maybeOne<{ bill_ref: string }>(db,
    `SELECT bill_ref FROM bill_allocations WHERE company_id = $1 AND ledger_id = $2 AND alloc_type IN ('NEW_REF','AGST_REF')
      GROUP BY bill_ref HAVING SUM(amount_minor) = $3 ORDER BY MIN(bill_date) LIMIT 1`, [companyId, ledgerId, want]);
  return r?.bill_ref ?? null;
}

/** Builds the voucher for one statement line once the other side ("counter" ledger) is known. */
export function bankPayload(b: { bankLedgerId: string; isCashBank: (id: string) => boolean }, l: StatementLine, counterLedgerId: string, billRef: string | null): VoucherInputRaw {
  const dir = direction(l);
  const amount = fromMinor(lineAmount(l));
  const contra = b.isCashBank(counterLedgerId);
  const voucherType = contra ? 'CONTRA' : dir === 'IN' ? 'RECEIPT' : 'PAYMENT';
  const bank = { ledgerId: b.bankLedgerId, side: dir === 'IN' ? 'DR' : 'CR', amount } as const;
  const other = { ledgerId: counterLedgerId, side: dir === 'IN' ? 'CR' : 'DR', amount, billRef } as const;
  return {
    voucherType, date: l.date,
    narration: [l.narration, l.ref ? `Ref ${l.ref}` : null].filter(Boolean).join(' · ').slice(0, 1000),
    entries: dir === 'IN' ? [bank, other] : [other, bank],
  };
}

/**
 * Proposes an entry for every statement line. Lines the rules can't place are returned with
 * suggestion.how = 'none' so the AI pass (if enabled) can try them.
 */
export async function proposeBankLines(db: Db, b: BankContext, st: Statement): Promise<Proposal[]> {
  const out: Proposal[] = [];
  const { ctx } = b;
  // Ledgers created during this run (Bank Charges, Bank Interest) aren't in ctx yet; they are never cash/bank.
  const isCashBank = (id: string) => { try { return ctx.isCashBank(id); } catch { return false; } };
  for (const l of st.lines) {
    const dir = direction(l);
    const amount = lineAmount(l);
    const source = { ...l, debitMinor: String(l.debitMinor), creditMinor: String(l.creditMinor), balanceMinor: l.balanceMinor === null ? null : String(l.balanceMinor), direction: dir };
    const issues = st.issues.filter((i) => i.lineNo === l.lineNo).map((i) => ({ code: i.code, severity: i.severity, message: i.message }));
    const base = { lineNo: l.lineNo, kind: 'BANK_LINE' as const, source, amountMinor: amount, entryDate: l.date, issues };

    const inBooks = await findInBooks(db, b, l);
    if (inBooks) {
      out.push({ ...base, status: 'IN_BOOKS', payload: null, matchedVoucherId: inBooks.voucherId,
        suggestion: { how: 'in_books', confidence: 'high', reason: `Already recorded: ${TYPE_WORD[inBooks.voucherType] ?? 'voucher'} No. ${inBooks.voucherNo} of ${shortDate(inBooks.date)}` } });
      continue;
    }

    let counter: { id: string; name: string } | null = null;
    let suggestion: Suggestion = { how: 'none', confidence: 'low', reason: 'No rule or party matched this narration' };
    let billRef: string | null = null;

    const learned = await learnedRule(db, ctx.company.id, dir, narrationPattern(l.narration));
    if (learned) {
      counter = { id: learned.ledger_id, name: learned.name };
      suggestion = { how: 'learned', confidence: learned.score >= 0.8 ? 'high' : 'medium', reason: `You chose ${learned.name} for a similar entry before` };
    }
    if (!counter) {
      const rule = RULES.find((r) => (r.dir === 'ANY' || r.dir === dir) && r.re.test(l.narration));
      if (rule) {
        const hit = rule.ledger === 'CASH' ? ctx.systemLedger('CASH')
          : (await ledgerByNames(db, ctx.company.id, rule.ledger)) ?? (rule.create ? await ensureLedger(db, ctx.company.id, rule.create.name, rule.create.group) : null);
        if (hit) {
          counter = { id: hit.id, name: hit.name };
          suggestion = { how: 'rule', confidence: 'high', reason: rule.reason };
        }
      }
    }
    if (!counter) {
      const party = await partyInNarration(db, b, l, dir);
      if (party) {
        counter = { id: party.ledger_id, name: party.name };
        billRef = await matchingBill(db, ctx.company.id, party.ledger_id, amount, dir);
        suggestion = {
          how: 'party', confidence: party.group_ok ? 'high' : 'medium',
          reason: `${party.name} appears in the narration${billRef ? `; settles bill ${billRef} of the same amount` : ''}${party.group_ok ? '' : ' (but the party is on the other side of your books; check)'}`,
        };
      }
    }

    if (counter) {
      // Cash/bank as the other side makes it a contra entry, which can't carry a bill reference.
      const payload = bankPayload({ bankLedgerId: b.bankLedgerId, isCashBank }, l, counter.id, isCashBank(counter.id) ? null : billRef);
      out.push({ ...base, status: suggestion.confidence === 'high' ? 'READY' : 'NEEDS_INPUT', payload, matchedVoucherId: null,
        suggestion: { ...suggestion, counterLedgerId: counter.id, counterName: counter.name } });
    } else {
      out.push({ ...base, status: 'NEEDS_INPUT', payload: null, matchedVoucherId: null, suggestion });
    }
  }
  return out;
}
