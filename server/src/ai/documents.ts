import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Decimal from 'decimal.js';
import type { PGlite } from '@electric-sql/pglite';
import { many, maybeOne, one } from '../db/client';
import { config } from '../config';
import { AppError, notFound } from '../lib/errors';
import { todayIST } from '../lib/dates';
import { isValidGstin, gstinState, stateCodeFrom } from '../lib/gstin';
import { fromMinor, percentToPpm } from '../lib/money';
import { KNOWN_GST_RATES_PPM } from '../tax/india-gst';
import { LedgerContext } from '../ledger/context';
import { createParty, type NewParty } from '../ledger/masters';
import { bigintJson, postVoucher, previewVoucher } from '../ledger/post';
import type { VoucherInputRaw } from '../ledger/contracts';
import { BILL_MEDIA, BILL_PROMPT, extractBill, type BillMedia } from './extract-bill';
import type { ParsedBill } from './bill-schema';
import { learnLine, learnPartyAlias, resolveLine, resolveParty, type LineResolution, type PartyResolution } from './resolver';
import { validateBill } from './validators';

const MAX_BYTES = 20 * 1024 * 1024;

export async function ingestDocument(db: PGlite, companyId: string, file: { name: string; mime: string; data: Buffer }, uploadedBy: string) {
  if (!BILL_MEDIA.has(file.mime)) throw new AppError('UNSUPPORTED_FILE', 415, 'Upload a PDF, JPEG, PNG, WebP or GIF');
  if (file.data.length > MAX_BYTES) throw new AppError('FILE_TOO_LARGE', 413, 'Files must be under 20 MB');
  const sha = crypto.createHash('sha256').update(file.data).digest('hex');
  const existing = await maybeOne<{ id: string; status: string }>(db, `SELECT id, status FROM documents WHERE company_id = $1 AND sha256 = $2`, [companyId, sha]);
  if (existing) throw new AppError('DUPLICATE_FILE', 409, 'This exact file was already uploaded', { documentId: existing.id, status: existing.status });
  fs.mkdirSync(config.uploadDir, { recursive: true });
  const ext = path.extname(file.name).toLowerCase().replace(/[^.a-z0-9]/g, '') || '';
  const key = `${sha}${ext}`;
  fs.writeFileSync(path.join(config.uploadDir, key), file.data);
  const doc = await one<{ id: string }>(db,
    `INSERT INTO documents (company_id, sha256, file_name, storage_key, mime, size_bytes, status, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,'RECEIVED',$7) RETURNING id`, [companyId, sha, file.name.slice(0, 200), key, file.mime, file.data.length, uploadedBy]);
  enqueue(db, doc.id);
  return doc;
}

// ---------- Background queue (in-process; swap for pg-boss on a server deployment) ----------
const queue: string[] = [];
let running = 0;
const CONCURRENCY = 2;

export function enqueue(db: PGlite, documentId: string) {
  queue.push(documentId);
  pump(db);
}

function pump(db: PGlite) {
  while (running < CONCURRENCY && queue.length) {
    const id = queue.shift()!;
    running++;
    processDocument(db, id)
      .catch((e) => console.error(`[documents] ${id} failed:`, e))
      .finally(() => { running--; pump(db); });
  }
}

export async function resumePending(db: PGlite) {
  const pending = await many<{ id: string }>(db, `SELECT id FROM documents WHERE status IN ('RECEIVED','PROCESSING') ORDER BY created_at`);
  for (const d of pending) enqueue(db, d.id);
}

export async function processDocument(db: PGlite, documentId: string) {
  const doc = await one<{ id: string; company_id: string; storage_key: string; mime: string; uploaded_by: string | null }>(db,
    `SELECT id, company_id, storage_key, mime, uploaded_by FROM documents WHERE id = $1`, [documentId]);
  await db.query(`UPDATE documents SET status = 'PROCESSING', error = NULL, updated_at = now() WHERE id = $1`, [documentId]);
  try {
    const ctx = await LedgerContext.load(db, doc.company_id);
    const data = fs.readFileSync(path.join(config.uploadDir, doc.storage_key));
    const bill = await extractBill(data, doc.mime as BillMedia, ctx.company);
    const review = await buildReview(db, ctx, bill);
    const draft = await one<{ id: string }>(db,
      `INSERT INTO voucher_drafts (company_id, payload, source, source_ref, created_by) VALUES ($1,$2,'OCR',$3,$4) RETURNING id`,
      [doc.company_id, JSON.stringify(review.draft), documentId, doc.uploaded_by ?? config.localUserId]);
    await db.query(
      `UPDATE documents SET status = 'NEEDS_REVIEW', extraction = $2, validation = $3, matches = $4, draft_id = $5,
              model = $6, prompt_version = $7, updated_at = now() WHERE id = $1`,
      [documentId, JSON.stringify(bill), JSON.stringify(review.issues), JSON.stringify(review.matches, bigintJson), draft.id, config.model, BILL_PROMPT]);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.query(`UPDATE documents SET status = 'FAILED', error = $2, updated_at = now() WHERE id = $1`, [documentId, message.slice(0, 1000)]);
  }
}

interface Matches {
  party: PartyResolution;
  proposedParty: NewParty | null;
  lines: (LineResolution & { description: string })[];
  recomputedTotal: string | null;
}

/** Turns an extraction into a purchase draft + validation issues + match explanations. */
export async function buildReview(db: PGlite, ctx: LedgerContext, bill: ParsedBill) {
  const party = await resolveParty(db, ctx.company.id, { name: bill.supplier.name.value, gstin: bill.supplier.gstin.value });
  const counterpartyId = party.match?.id ?? null;
  const supplierGstin = bill.supplier.gstin.value?.toUpperCase() ?? null;
  const proposedParty: NewParty | null = counterpartyId ? null : {
    name: bill.supplier.name.value ?? 'Unknown supplier',
    kind: 'SUPPLIER',
    gstin: supplierGstin && isValidGstin(supplierGstin) ? supplierGstin : null,
    stateCode: supplierGstin && isValidGstin(supplierGstin) ? gstinState(supplierGstin) : stateCodeFrom(bill.supplier.state),
    phone: bill.supplier.phone,
    creditDays: bill.due_date && bill.invoice_date.value
      ? Math.max(0, Math.round((Date.parse(bill.due_date) - Date.parse(bill.invoice_date.value)) / 864e5)) : null,
  };

  const unregistered = !supplierGstin || bill.document_type === 'BILL_OF_SUPPLY';
  const items: NonNullable<VoucherInputRaw['items']> = [];
  const lineMatches: Matches['lines'] = [];
  for (const l of bill.line_items) {
    const m = await resolveLine(db, ctx.company.id, counterpartyId, l.description, l.hsn_sac);
    lineMatches.push({ ...m, description: l.description });
    const amount = lineTaxable(l);
    if (amount === null) continue;
    const useItem = Boolean(m.itemId && l.quantity && new Decimal(l.quantity).gt(0));
    items.push({
      itemId: useItem ? m.itemId : null,
      ledgerId: useItem ? null : m.ledgerId,
      description: l.description.slice(0, 500),
      qty: useItem ? l.quantity : null,
      rate: l.unit_price,
      amount: amount.toFixed(2),
      gstRate: unregistered ? '0' : lineRate(l, amount),
      hsnSac: l.hsn_sac && /^\d{4,8}$/.test(l.hsn_sac) ? l.hsn_sac : null,
    });
  }
  for (const c of bill.charges) {
    const m = await resolveLine(db, ctx.company.id, counterpartyId, c.label, c.hsn_sac);
    lineMatches.push({ ...m, description: c.label });
    items.push({
      ledgerId: m.ledgerId, description: c.label, amount: new Decimal(c.amount).toFixed(2),
      gstRate: unregistered ? '0' : c.gst_rate_percent ?? '0',
      hsnSac: c.hsn_sac && /^\d{4,8}$/.test(c.hsn_sac) ? c.hsn_sac : null,
    });
  }

  const paidCash = bill.payment.status === 'PAID' && bill.payment.mode === 'CASH';
  const paidBank = bill.payment.status === 'PAID' && bill.payment.mode && bill.payment.mode !== 'CASH';
  const banks = ctx.bankLedgers();
  const draft: VoucherInputRaw = {
    voucherType: bill.document_type === 'CREDIT_NOTE' ? 'DEBIT_NOTE' : 'PURCHASE',
    date: bill.invoice_date.value && bill.invoice_date.value <= todayIST() ? bill.invoice_date.value : todayIST(),
    counterpartyId,
    paymentMode: paidCash ? 'CASH' : paidBank && banks.length ? 'BANK' : 'CREDIT',
    bankLedgerId: paidBank && banks.length ? banks[0].id : null,
    partyRefNo: bill.invoice_number.value?.slice(0, 16) ?? null,
    partyRefDate: bill.invoice_date.value,
    originalRef: bill.original_invoice_ref,
    dueDate: bill.due_date,
    reverseCharge: bill.reverse_charge === true,
    items,
    narration: `Scanned bill ${bill.invoice_number.value ?? ''} from ${bill.supplier.name.value ?? 'supplier'}`.trim(),
  };

  // Recompute with our own tax engine; credit mode needs a party, so preview as cash when the party is new.
  let recomputed: Decimal | null = null;
  try {
    const p = await previewVoucher(db, ctx.company.id, { ...draft, paymentMode: counterpartyId ? draft.paymentMode : 'CASH', bankLedgerId: draft.bankLedgerId, confirmWarnings: true });
    recomputed = new Decimal(fromMinor(p.totalMinor));
  } catch { /* incomplete draft; the reviewer will fix it */ }

  const issues = await validateBill(db, ctx.company, bill, counterpartyId, recomputed);
  const matches: Matches = { party, proposedParty, lines: lineMatches, recomputedTotal: recomputed?.toFixed(2) ?? null };
  return { draft, issues, matches };
}

function lineTaxable(l: ParsedBill['line_items'][number]): Decimal | null {
  if (l.taxable_value) return new Decimal(l.taxable_value);
  if (l.quantity && l.unit_price) return new Decimal(l.quantity).times(l.unit_price).minus(l.discount ?? 0);
  if (l.line_total) {
    const tax = [l.cgst, l.sgst, l.igst, l.cess].reduce((s, x) => s.plus(x ?? 0), new Decimal(0));
    return new Decimal(l.line_total).minus(tax);
  }
  return null;
}

/** Printed rate, else inferred from printed tax amounts (snapped to a known slab), else 0. */
function lineRate(l: ParsedBill['line_items'][number], taxable: Decimal): string {
  if (l.gst_rate_percent) return l.gst_rate_percent;
  const tax = [l.cgst, l.sgst, l.igst].reduce((s, x) => s.plus(x ?? 0), new Decimal(0));
  if (tax.gt(0) && taxable.gt(0)) {
    const pct = tax.div(taxable).times(100);
    const slab = [...KNOWN_GST_RATES_PPM].map((p) => p / 10_000).find((r) => pct.minus(r).abs().lt(0.2));
    if (slab !== undefined) return String(slab);
  }
  return '0';
}

export async function acceptDocument(db: PGlite, companyId: string, documentId: string, body: { draft: VoucherInputRaw; newParty?: NewParty | null; confirmWarnings?: boolean }, userId: string) {
  const doc = await maybeOne<{ id: string; status: string; draft_id: string | null; extraction: ParsedBill | null }>(db,
    `SELECT id, status, draft_id, extraction FROM documents WHERE id = $1 AND company_id = $2`, [documentId, companyId]);
  if (!doc) throw notFound('Document');
  if (doc.status === 'ACCEPTED') throw new AppError('ALREADY_ACCEPTED', 409, 'This bill has already been posted');
  let draft = { ...body.draft };
  if (!draft.counterpartyId && body.newParty) {
    const created = await createParty(db, companyId, { ...body.newParty, kind: 'SUPPLIER' }, userId, 'OCR');
    draft = { ...draft, counterpartyId: created.id };
  }
  if (doc.draft_id) await db.query(`UPDATE voucher_drafts SET payload = $2, updated_at = now() WHERE id = $1`, [doc.draft_id, JSON.stringify(draft)]);
  const posted = await postVoucher(db, companyId, { ...draft, confirmWarnings: Boolean(body.confirmWarnings) },
    { source: 'OCR', idempotencyKey: `doc:${documentId}`, userId, draftId: doc.draft_id });

  // Learn from the reviewer: printed supplier name -> party; line description -> item / ledger.
  const printed = doc.extraction?.supplier.name.value;
  if (printed && draft.counterpartyId) await learnPartyAlias(db, companyId, printed, draft.counterpartyId);
  if (draft.counterpartyId) {
    for (const it of draft.items ?? []) {
      if (it.description) await learnLine(db, companyId, draft.counterpartyId, it.description, it.itemId ?? null, it.ledgerId ?? null);
    }
  }
  await db.query(`UPDATE documents SET status = 'ACCEPTED', voucher_id = $2, updated_at = now() WHERE id = $1`, [documentId, posted.id]);
  return posted;
}

export async function rejectDocument(db: PGlite, companyId: string, documentId: string) {
  const doc = await maybeOne<{ draft_id: string | null; status: string }>(db, `SELECT draft_id, status FROM documents WHERE id = $1 AND company_id = $2`, [documentId, companyId]);
  if (!doc) throw notFound('Document');
  if (doc.status === 'ACCEPTED') throw new AppError('ALREADY_ACCEPTED', 409, 'Posted bills must be reversed from the daybook');
  await db.query(`UPDATE documents SET status = 'REJECTED', updated_at = now() WHERE id = $1`, [documentId]);
  if (doc.draft_id) await db.query(`UPDATE voucher_drafts SET status = 'DISCARDED', updated_at = now() WHERE id = $1`, [doc.draft_id]);
}

export function documentFilePath(storageKey: string) {
  return path.join(config.uploadDir, path.basename(storageKey));
}

