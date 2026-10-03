import * as z from 'zod/v4';

/** Spec section 3.2. Amounts are decimal strings; null = not printed. */
const Str = z.string().nullable();

export const Evidence = z.object({
  value: Str.describe('Normalised value (dates YYYY-MM-DD, amounts 1234.50)'),
  raw: Str.describe('Exact characters as printed'),
  page: z.number().int().nullable().describe('1-based page number'),
});

export const PartyBlock = z.object({
  name: Evidence,
  gstin: Evidence,
  address: Str,
  state: Str.describe('As printed: "Maharashtra" or "27"'),
  phone: Str,
});

export const LineItem = z.object({
  line_no: z.number().int(),
  description: z.string(),
  hsn_sac: Str,
  quantity: Str,
  uom: Str,
  unit_price: Str,
  discount: Str,
  taxable_value: Str,
  gst_rate_percent: Str,
  cgst: Str,
  sgst: Str,
  igst: Str,
  cess: Str,
  line_total: Str,
});

export const Charge = z.object({
  label: z.string(),
  amount: z.string(),
  gst_rate_percent: Str,
  hsn_sac: Str,
});

export const TaxSummaryRow = z.object({
  gst_rate_percent: z.string(),
  taxable_value: z.string(),
  cgst: Str,
  sgst: Str,
  igst: Str,
  cess: Str,
});

export const ParsedBill = z.object({
  document_type: z.enum(['TAX_INVOICE', 'BILL_OF_SUPPLY', 'CREDIT_NOTE', 'DEBIT_NOTE', 'CASH_MEMO', 'EXPENSE_RECEIPT', 'NOT_A_BILL']),
  supplier: PartyBlock,
  buyer: PartyBlock,
  invoice_number: Evidence,
  invoice_date: Evidence,
  due_date: Str,
  place_of_supply: Str,
  reverse_charge: z.boolean().nullable(),
  irn: Str,
  original_invoice_ref: Str,
  currency: z.string(),
  line_items: z.array(LineItem),
  charges: z.array(Charge),
  tax_summary: z.array(TaxSummaryRow),
  totals: z.object({
    subtotal: Str,
    discount_total: Str,
    tax_total: Str,
    round_off: Str,
    grand_total: Evidence,
    amount_in_words: Str,
  }),
  payment: z.object({
    status: z.enum(['UNPAID', 'PAID', 'PARTIAL', 'UNKNOWN']),
    mode: z.enum(['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CHEQUE']).nullable(),
    amount_paid: Str,
    reference: Str,
  }),
  warnings: z.array(z.string()),
});
export type ParsedBill = z.infer<typeof ParsedBill>;
