/**
 * Puts a sample scanned bill into the review queue without calling the AI, so the
 * review screen can be tried before an ANTHROPIC_API_KEY is set. Stop the server first
 * (the embedded database allows one process at a time).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config';
import { many, one, openDb } from '../db/client';
import { addDays, todayIST } from '../lib/dates';
import { makeGstin } from '../lib/gstin';
import { LedgerContext } from '../ledger/context';
import { buildReview } from '../ai/documents';
import { seedDemo } from '../db/demo';
import type { ParsedBill } from '../ai/bill-schema';

const db = await openDb(config.dbDir);
const companies = await many<{ id: string }>(db, 'SELECT id FROM companies ORDER BY created_at LIMIT 1');
const companyId = companies[0]?.id ?? (await seedDemo(db));

const gstin = makeGstin('27', 'AAPFB1234C');
const date = addDays(todayIST(), -1);
const ev = (value: string | null) => ({ value, raw: value, page: 1 });
const bill: ParsedBill = {
  document_type: 'TAX_INVOICE',
  supplier: { name: ev('SHREE BALAJI CEMENT AGENCY'), gstin: ev(gstin), address: 'Plot 14, MIDC Bhosari, Pune 411026', state: 'Maharashtra', phone: null },
  buyer: { name: ev('Sharma Building Supplies'), gstin: ev(null), address: null, state: 'Maharashtra', phone: null },
  invoice_number: ev(`SBC/${crypto.randomInt(1000, 9999)}`), invoice_date: ev(date), due_date: addDays(date, 30), place_of_supply: '27',
  reverse_charge: false, irn: null, original_invoice_ref: null, currency: 'INR',
  line_items: [{ line_no: 1, description: 'UltraTech OPC 53 Grade Cement 50kg', hsn_sac: '2523', quantity: '100', uom: 'BAG', unit_price: '340.00',
    discount: null, taxable_value: '34000.00', gst_rate_percent: '18', cgst: '3060.00', sgst: '3060.00', igst: null, cess: null, line_total: '40120.00' }],
  charges: [{ label: 'Freight', amount: '500.00', gst_rate_percent: '18', hsn_sac: '9965' }],
  tax_summary: [{ gst_rate_percent: '18', taxable_value: '34500.00', cgst: '3105.00', sgst: '3105.00', igst: null, cess: null }],
  totals: { subtotal: '34500.00', discount_total: null, tax_total: '6210.00', round_off: '0.00', grand_total: ev('40710.00'), amount_in_words: 'Rupees Forty Thousand Seven Hundred Ten Only' },
  payment: { status: 'UNPAID', mode: null, amount_paid: null, reference: null },
  warnings: [],
};

const here = path.dirname(fileURLToPath(import.meta.url));
const svg = fs.readFileSync(path.join(here, '..', 'db', 'sample-bill.svg'), 'utf8')
  .replace('27AAPFB1234C1Z{CHECK}', gstin).replace('{DATE}', date.split('-').reverse().join('/'))
  .replace('SBC/0777', bill.invoice_number.value!);
const data = Buffer.from(svg);
const sha = crypto.createHash('sha256').update(data).digest('hex');
fs.mkdirSync(config.uploadDir, { recursive: true });
fs.writeFileSync(path.join(config.uploadDir, `${sha}.svg`), data);

const ctx = await LedgerContext.load(db, companyId);
const review = await buildReview(db, ctx, bill);
const draft = await one<{ id: string }>(db,
  `INSERT INTO voucher_drafts (company_id, payload, source, created_by) VALUES ($1,$2,'OCR',$3) RETURNING id`,
  [companyId, JSON.stringify(review.draft), config.localUserId]);
await db.query(
  `INSERT INTO documents (company_id, sha256, file_name, storage_key, mime, size_bytes, status, extraction, validation, matches, draft_id, model, prompt_version)
   VALUES ($1,$2,'sample-bill.svg',$3,'image/svg+xml',$4,'NEEDS_REVIEW',$5,$6,$7,$8,'demo (no AI call)','sample')`,
  [companyId, sha, `${sha}.svg`, data.length, JSON.stringify(bill), JSON.stringify(review.issues), JSON.stringify(review.matches), draft.id]);
console.log(`Sample bill ${bill.invoice_number.value} added to the review queue (${review.issues.length} checks). Start the server and press R on the Gateway.`);
await db.close();
