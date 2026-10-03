import Decimal from 'decimal.js';
import { many, maybeOne, type Db } from '../../db/client';
import { fiscalYear } from '../../lib/dates';
import { isValidGstin } from '../../lib/gstin';
import { formatINR, fromMinor } from '../../lib/money';
import { normName } from '../../lib/text';
import { KNOWN_GST_RATES_PPM } from '../../tax/india-gst';
import type { LedgerContext } from '../../ledger/context';
import type { VoucherInputRaw } from '../../ledger/contracts';
import { resolveParty } from '../resolver';
import type { Proposal, Suggestion } from './entries';
import type { JournalDraft, Register } from './sheets';

/** Account name as written in a working -> ledger: exact name, alias, then close spelling. */
export async function ledgerForName(db: Db, companyId: string, name: string): Promise<{ id: string; name: string } | null> {
  const n = normName(name);
  if (!n) return null;
  const exact = await maybeOne<{ id: string; name: string }>(db,
    `SELECT id, name FROM ledgers WHERE company_id = $1 AND is_active AND (norm_name = $2 OR lower(name) = lower($3) OR $3 = ANY(aliases)) LIMIT 1`, [companyId, n, name.trim()]);
  if (exact) return exact;
  const close = await many<{ id: string; name: string; score: number }>(db,
    `SELECT id, name, similarity(norm_name, $2)::float8 AS score FROM ledgers
      WHERE company_id = $1 AND is_active AND tax_component IS NULL AND similarity(norm_name, $2) >= 0.75 ORDER BY score DESC LIMIT 2`, [companyId, n]);
  if (close[0] && (!close[1] || close[0].score - close[1].score >= 0.1)) return close[0];
  return null;
}

/**
 * A journal working -> voucher. Cash/bank on one side makes it a Payment or Receipt (journals can't
 * touch cash or bank); both sides cash/bank make it a Contra.
 */
export async function proposeJournal(db: Db, ctx: LedgerContext, d: JournalDraft, fallbackDate: string | null,
  resolved?: (string | null)[], groupHints?: (string | null)[]): Promise<Proposal> {
  const ids: (string | null)[] = [];
  const unmatched: NonNullable<Suggestion['unmatched']> = [];
  for (const [i, line] of d.lines.entries()) {
    const id = resolved?.[i] ?? (await ledgerForName(db, ctx.company.id, line.account))?.id ?? null;
    ids.push(id);
    if (!id) unmatched.push({ index: i, account: line.account, groupCode: groupHints?.[i] ?? null });
  }
  const dr = d.lines.filter((l) => l.side === 'DR').reduce((s, l) => s + l.amountMinor, 0n);
  const cr = d.lines.filter((l) => l.side === 'CR').reduce((s, l) => s + l.amountMinor, 0n);
  const issues: Proposal['issues'] = [];
  if (dr !== cr) issues.push({ code: 'NOT_BALANCED', severity: 'error', message: `Debits ₹${formatINR(dr)} and credits ₹${formatINR(cr)} differ.` });
  for (const u of unmatched) issues.push({ code: 'NO_LEDGER', severity: 'error', message: `No ledger called "${u.account}". Pick one or create it.` });

  const date = d.date ?? fallbackDate;
  let payload: VoucherInputRaw | null = null;
  if (!unmatched.length) {
    const cashBank = ids.map((id) => ctx.isCashBank(id!));
    const type = cashBank.every(Boolean) ? 'CONTRA'
      : d.lines.some((l, i) => cashBank[i] && l.side === 'CR') ? 'PAYMENT'
      : d.lines.some((l, i) => cashBank[i] && l.side === 'DR') ? 'RECEIPT' : 'JOURNAL';
    payload = {
      voucherType: type, date: date ?? '',
      narration: [d.narration, d.ref ? `Ref ${d.ref}` : null].filter(Boolean).join(' · ') || null,
      entries: d.lines.map((l, i) => ({ ledgerId: ids[i]!, side: l.side, amount: fromMinor(l.amountMinor) })),
    };
  }
  return {
    lineNo: d.lineNo, kind: 'JOURNAL', status: payload && !issues.length ? 'READY' : 'NEEDS_INPUT',
    source: { ...d, lines: d.lines.map((l) => ({ ...l, amountMinor: String(l.amountMinor) })) },
    payload, suggestion: { how: 'sheet', confidence: unmatched.length ? 'low' : 'high', reason: 'From the working', unmatched },
    issues, matchedVoucherId: null, amountMinor: dr, entryDate: date,
  };
}

/** Effective GST rate from tax / taxable, snapped to a real slab (else null). */
function inferRate(taxable: bigint, tax: bigint): string | null {
  if (taxable <= 0n) return null;
  if (tax === 0n) return '0';
  const pct = new Decimal(tax.toString()).div(taxable.toString()).times(100);
  const slab = [...KNOWN_GST_RATES_PPM].map((p) => p / 10_000).find((r) => pct.minus(r).abs().lt(0.15));
  return slab === undefined ? null : String(slab);
}

/** Invoice register rows -> sales or purchase vouchers, one line each (ledger level, no stock quantities). */
export async function proposeRegister(db: Db, ctx: LedgerContext, reg: Register, kindOverride: 'SALES' | 'PURCHASE' | null): Promise<Proposal[]> {
  const kind = kindOverride ?? reg.kind;
  const out: Proposal[] = [];
  for (const r of reg.rows) {
    const issues: Proposal['issues'] = [];
    const source = { ...r, taxableMinor: String(r.taxableMinor), taxMinor: String(r.taxMinor), totalMinor: r.totalMinor === null ? null : String(r.totalMinor) };
    const base = { lineNo: r.lineNo, kind: 'REGISTER_ROW' as const, source, amountMinor: r.totalMinor ?? r.taxableMinor + r.taxMinor, entryDate: r.date };
    if (!kind) {
      out.push({ ...base, status: 'NEEDS_INPUT', payload: null, matchedVoucherId: null, issues: [{ code: 'REGISTER_KIND', severity: 'error', message: 'Is this a sales or a purchase register? Choose above.' }],
        suggestion: { how: 'sheet', confidence: 'low', reason: 'Register type unknown' } });
      continue;
    }
    const party = await resolveParty(db, ctx.company.id, { name: r.partyName, gstin: r.gstin });
    const counterpartyId = party.status === 'MATCHED' ? party.match!.id : null;
    const gstin = r.gstin && isValidGstin(r.gstin) ? r.gstin : null;
    if (r.gstin && !gstin) issues.push({ code: 'GSTIN_INVALID', severity: 'warning', message: `GSTIN ${r.gstin} fails the check digit.` });

    // Already booked? Same party + invoice number + financial year.
    if (counterpartyId && r.date) {
      const dup = await maybeOne<{ id: string; voucher_no: string }>(db,
        `SELECT v.id, v.voucher_no FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id
          WHERE v.company_id = $1 AND v.counterparty_id = $2 AND lower(v.party_ref_no) = lower($3) AND t.base_type = $4 AND v.fiscal_year = $5
            AND v.reverses_voucher_id IS NULL AND NOT EXISTS (SELECT 1 FROM vouchers x WHERE x.reverses_voucher_id = v.id)`,
        [ctx.company.id, counterpartyId, r.invoiceNo, kind, fiscalYear(r.date, ctx.company.fy_start_month)]);
      if (dup) {
        out.push({ ...base, status: 'IN_BOOKS', payload: null, matchedVoucherId: dup.id, issues,
          suggestion: { how: 'in_books', confidence: 'high', reason: `Invoice ${r.invoiceNo} is already booked as ${kind.toLowerCase()} ${dup.voucher_no}` } });
        continue;
      }
    }
    const rate = r.ratePercent ?? inferRate(r.taxableMinor, r.taxMinor);
    if (rate === null) issues.push({ code: 'RATE_UNCLEAR', severity: 'error', message: 'The GST rate could not be worked out from the tax and taxable value; enter it.' });
    const payload: VoucherInputRaw = {
      voucherType: kind, date: r.date ?? '', counterpartyId, paymentMode: 'CREDIT',
      partyRefNo: r.invoiceNo, partyRefDate: kind === 'PURCHASE' ? r.date : null,
      items: [{ description: `${kind === 'SALES' ? 'Invoice' : 'Bill'} ${r.invoiceNo}`, amount: fromMinor(r.taxableMinor), gstRate: rate ?? '0' }],
      narration: `Imported from register: ${kind === 'SALES' ? 'invoice' : 'bill'} ${r.invoiceNo}, ${r.partyName}`,
    };
    const suggestion: Suggestion = counterpartyId
      ? { how: 'sheet', confidence: rate === null ? 'low' : 'high', reason: `Party ${party.match!.name} (${party.reason})` }
      : { how: 'sheet', confidence: rate === null ? 'low' : 'high', reason: `New party ${r.partyName} will be created`,
          newParty: { name: r.partyName, gstin, kind: kind === 'SALES' ? 'CUSTOMER' : 'SUPPLIER' } };
    if (!counterpartyId) issues.push({ code: 'NEW_PARTY', severity: 'info', message: `${r.partyName} is not in your books; it will be created when you post.` });
    out.push({ ...base, status: 'READY', payload, matchedVoucherId: null, issues, suggestion });
  }
  return out;
}
