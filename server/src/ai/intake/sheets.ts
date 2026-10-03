import Decimal from 'decimal.js';
import { cellText, decToMinor, headerKey, parseAmount, parseDate, type Cell } from '../../lib/parse';
import type { Sheet } from './files';

// ---------------------------------------------------------------- Journal workings
// A sheet with Ledger/Account + Debit + Credit columns (optionally Date, Voucher no., Narration).

export interface JournalDraft {
  lineNo: number;
  date: string | null;
  narration: string | null;
  ref: string | null;
  lines: { account: string; side: 'DR' | 'CR'; amountMinor: bigint }[];
}

function findCols(rows: Cell[][], spec: Record<string, RegExp>, required: string[]) {
  for (let r = 0; r < Math.min(rows.length, 30); r++) {
    const cols: Record<string, number> = {};
    rows[r].forEach((c, i) => {
      const h = headerKey(c);
      if (!h) return;
      for (const [k, re] of Object.entries(spec)) if (cols[k] === undefined && re.test(h)) { cols[k] = i; break; }
    });
    if (required.every((k) => cols[k] !== undefined)) return { row: r, cols };
  }
  return null;
}

const JOURNAL_SPEC: Record<string, RegExp> = {
  voucher: /^(jv|voucher|entry|journal)( no| number| #| ref)?$|^(jv|entry) no/,
  date: /^date$|^(jv|entry|voucher) date$/,
  account: /^(ledger|account|account head|head|particulars|account name|ledger name|gl account)$/,
  debit: /^(debit|dr|debit amount|dr amount)( rs| inr)?$/,
  credit: /^(credit|cr|credit amount|cr amount)( rs| inr)?$/,
  narration: /narration|description|remarks|memo/,
};

export function parseJournalSheet(sheet: Sheet): JournalDraft[] | null {
  const found = findCols(sheet.rows, JOURNAL_SPEC, ['account', 'debit', 'credit']);
  if (!found) return null;
  const { row: h, cols } = found;
  const drafts: JournalDraft[] = [];
  let cur: JournalDraft | null = null;
  let lastVoucher: string | null = null;
  const balanced = (d: JournalDraft) => d.lines.length >= 2 && d.lines.reduce((s, l) => s + (l.side === 'DR' ? l.amountMinor : -l.amountMinor), 0n) === 0n;

  for (let r = h + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r];
    const account = cellText(row[cols.account] ?? null);
    const dr = parseAmount(row[cols.debit] ?? null);
    const cr = parseAmount(row[cols.credit] ?? null);
    if (!account || /^(total|grand total)$/i.test(account) || (!dr && !cr)) continue;
    const voucher = cols.voucher !== undefined ? cellText(row[cols.voucher] ?? null) || null : null;
    const date = cols.date !== undefined ? parseDate(row[cols.date] ?? null) : null;
    const narration = cols.narration !== undefined ? cellText(row[cols.narration] ?? null) || null : null;

    // New entry: a new voucher number, or (without voucher numbers) the previous entry is balanced.
    const startNew = !cur
      || (voucher !== null && voucher !== lastVoucher)
      || (cols.voucher === undefined && balanced(cur));
    if (startNew) {
      cur = { lineNo: drafts.length + 1, date, narration, ref: voucher, lines: [] };
      drafts.push(cur);
    }
    if (voucher) lastVoucher = voucher;
    if (date && !cur!.date) cur!.date = date;
    if (narration && !cur!.narration) cur!.narration = narration;
    if (dr && !dr.isZero()) cur!.lines.push({ account, side: 'DR', amountMinor: decToMinor(dr.abs()) });
    if (cr && !cr.isZero()) cur!.lines.push({ account, side: 'CR', amountMinor: decToMinor(cr.abs()) });
  }
  return drafts.length ? drafts : null;
}

// ---------------------------------------------------------------- Invoice registers
// Exports from billing software: one invoice per row with party, taxable value and tax columns.

export interface RegisterRow {
  lineNo: number;
  invoiceNo: string;
  date: string | null;
  partyName: string;
  gstin: string | null;
  taxableMinor: bigint;
  taxMinor: bigint;
  totalMinor: bigint | null;
  ratePercent: string | null;
}

export interface Register { kind: 'SALES' | 'PURCHASE' | null; rows: RegisterRow[] }

const REGISTER_SPEC: Record<string, RegExp> = {
  invoice: /^(invoice|inv|bill|voucher|document|doc)( no| number| #|no)?\.?$|^(invoice|inv|bill) (no|number)/,
  date: /^(invoice |inv |bill |voucher )?date$/,
  party: /^(party|customer|buyer|supplier|vendor|client)( name)?$|^(name of (the )?(party|customer|supplier|buyer))$|^billed to$/,
  gstin: /gstin|gst no|gst number/,
  taxable: /^(taxable|taxable value|taxable amount|assessable value|net amount|value)( rs| inr)?$/,
  rate: /^(gst )?rate( %)?$|^gst %$|^tax rate/,
  cgst: /^cgst( amount| amt)?( rs| inr)?$/,
  sgst: /^(sgst|utgst)( amount| amt)?( rs| inr)?$/,
  igst: /^igst( amount| amt)?( rs| inr)?$/,
  cess: /^cess( amount| amt)?$/,
  tax: /^(total )?(gst|tax)( amount| amt)?$/,
  total: /^(invoice |bill |grand )?(total|amount|value)( rs| inr)?$|^invoice value$/,
};

export function parseRegisterSheet(sheet: Sheet): Register | null {
  const found = findCols(sheet.rows, REGISTER_SPEC, ['invoice', 'party']);
  if (!found || (found.cols.taxable === undefined && found.cols.total === undefined)) return null;
  const { row: h, cols } = found;
  const headerText = sheet.rows[h].map(headerKey).join(' ');
  const title = [sheet.name, ...sheet.rows.slice(0, h).flat().map(cellText)].join(' ').toLowerCase();
  const kind: Register['kind'] = /supplier|vendor/.test(headerText) || /purchase/.test(title) ? 'PURCHASE'
    : /customer|buyer|billed to|client/.test(headerText) || /sales|sale /.test(title) ? 'SALES' : null;

  const amt = (k: string, row: Cell[]) => (cols[k] !== undefined ? parseAmount(row[cols[k]] ?? null) : null);
  const rows: RegisterRow[] = [];
  for (let r = h + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r];
    const invoiceNo = cellText(row[cols.invoice] ?? null);
    const partyName = cellText(row[cols.party] ?? null);
    if (!invoiceNo || !partyName || /^total/i.test(invoiceNo) || /^total/i.test(partyName)) continue;
    const parts = ['cgst', 'sgst', 'igst', 'cess'].map((k) => amt(k, row)).filter((x): x is Decimal => Boolean(x));
    const tax = parts.length ? parts.reduce((s, x) => s.plus(x.abs()), new Decimal(0)) : (amt('tax', row)?.abs() ?? null);
    const total = amt('total', row)?.abs() ?? null;
    let taxable = amt('taxable', row)?.abs() ?? null;
    if (!taxable && total) taxable = tax ? total.minus(tax) : total;
    if (!taxable) continue;
    const rateCell = cols.rate !== undefined ? cellText(row[cols.rate] ?? null).replace('%', '').trim() : '';
    rows.push({
      lineNo: rows.length + 1,
      invoiceNo: invoiceNo.slice(0, 16),
      date: cols.date !== undefined ? parseDate(row[cols.date] ?? null) : null,
      partyName,
      gstin: cols.gstin !== undefined ? cellText(row[cols.gstin] ?? null).toUpperCase().replace(/\s/g, '') || null : null,
      taxableMinor: decToMinor(taxable),
      taxMinor: tax ? decToMinor(tax) : 0n,
      totalMinor: total ? decToMinor(total) : null,
      ratePercent: /^\d+(\.\d+)?$/.test(rateCell) ? rateCell : null,
    });
  }
  return rows.length ? { kind, rows } : null;
}
