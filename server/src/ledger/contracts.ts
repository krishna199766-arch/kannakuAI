import * as z from 'zod/v4';

const Uuid = z.string().regex(/^[0-9a-f-]{36}$/i, 'expected a uuid');
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
/** Decimal string in rupees / units: "5500", "5500.50", "-12.5" */
export const Dec = z.union([z.string(), z.number()])
  .transform((v) => String(v).replace(/,/g, '').trim())
  .pipe(z.string().regex(/^-?\d+(\.\d+)?$/, 'expected a decimal number'));

export const BaseType = z.enum([
  'SALES', 'PURCHASE', 'PAYMENT', 'RECEIPT', 'JOURNAL', 'CONTRA', 'DEBIT_NOTE', 'CREDIT_NOTE', 'OPENING',
]);
export type BaseType = z.infer<typeof BaseType>;

/** Item / invoice line for Sales, Purchase, Credit Note, Debit Note. */
export const ItemLine = z.object({
  itemId: Uuid.nullish(),
  ledgerId: Uuid.nullish(),                 // sales / purchase / expense ledger
  description: z.string().max(500).nullish(),
  qty: Dec.nullish(),
  rate: Dec.nullish(),
  amount: Dec,                              // taxable value, or gross if pricesIncludeTax
  gstRate: Dec.default('0'),                // percent, e.g. "18"
  cessRate: Dec.nullish(),
  hsnSac: z.string().regex(/^\d{4,8}$/).nullish(),
  itcEligible: z.boolean().default(true),
  godownId: Uuid.nullish(),
});
export type ItemLine = z.infer<typeof ItemLine>;

/** Accounting line for Payment, Receipt, Contra, Journal, Opening. */
export const EntryLine = z.object({
  ledgerId: Uuid,
  side: z.enum(['DR', 'CR']),
  amount: Dec,
  billRef: z.string().max(40).nullish(),
  billType: z.enum(['NEW_REF', 'AGST_REF', 'ADVANCE', 'ON_ACCOUNT']).nullish(),
});
export type EntryLine = z.infer<typeof EntryLine>;

export const VoucherInput = z.object({
  voucherType: BaseType,
  date: IsoDate,
  counterpartyId: Uuid.nullish(),
  paymentMode: z.enum(['CREDIT', 'CASH', 'BANK']).default('CREDIT'),
  bankLedgerId: Uuid.nullish(),
  partyRefNo: z.string().max(16).nullish(),
  partyRefDate: IsoDate.nullish(),
  originalRef: z.string().max(40).nullish(),
  dueDate: IsoDate.nullish(),
  placeOfSupply: z.string().regex(/^\d{2}$/).nullish(),
  reverseCharge: z.boolean().default(false),
  pricesIncludeTax: z.boolean().default(false),
  items: z.array(ItemLine).default([]),
  entries: z.array(EntryLine).default([]),
  narration: z.string().max(1000).nullish(),
  confirmWarnings: z.boolean().default(false),
});
export type VoucherInput = z.infer<typeof VoucherInput>;
export type VoucherInputRaw = z.input<typeof VoucherInput>;

export const TRADING_TYPES: BaseType[] = ['SALES', 'PURCHASE', 'CREDIT_NOTE', 'DEBIT_NOTE'];
