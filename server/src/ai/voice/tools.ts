import type Anthropic from '@anthropic-ai/sdk';

/**
 * Strict tool schemas (spec 4.3). Deliberately no debit/credit field anywhere.
 *
 * No nullable fields: the API allows only 16 union-typed fields across all strict tools in a request.
 * "Not said" is an empty string (or NOT_SAID), and normalizeToolInput() turns it back into null.
 */

const entity = (description: string) => ({
  type: 'object',
  description: `${description}. Both fields "" if the user did not mention one`,
  additionalProperties: false,
  required: ['candidate_id', 'spoken'],
  properties: {
    candidate_id: { type: 'string', description: 'A key from <candidates> (e.g. "p1"), or "" if none clearly fits' },
    spoken: { type: 'string', description: 'The words the user used for it' },
  },
});

const spokenNumber = (description: string) => ({
  type: 'object',
  description: `${description}. Both fields "" if the user did not say it`,
  additionalProperties: false,
  required: ['value', 'spoken'],
  properties: {
    value: { type: 'string', description: 'Decimal digits, e.g. "5500"' },
    spoken: { type: 'string', description: 'Exact transcript words that state this number' },
  },
});

const text = (description: string) => ({ type: 'string', description: `${description}; "" if not said` });

const PERIODS = ['TODAY', 'YESTERDAY', 'THIS_WEEK', 'THIS_MONTH', 'LAST_MONTH', 'THIS_QUARTER', 'LAST_QUARTER', 'THIS_FY', 'LAST_FY', 'AS_OF_TODAY'];

export const VOICE_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'record_voucher',
    description: "Prepare (not post) a voucher from the user's spoken instruction. Use only values the user said.",
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['voucher_type', 'date', 'party', 'payment_mode', 'items', 'other_ledger', 'amount', 'amount_includes_tax', 'gst_rate_percent', 'bill_no', 'narration', 'missing'],
      properties: {
        voucher_type: { type: 'string', enum: ['SALES', 'PURCHASE', 'PAYMENT', 'RECEIPT', 'CONTRA', 'JOURNAL', 'CREDIT_NOTE', 'DEBIT_NOTE'] },
        date: text('YYYY-MM-DD only if the user said a date ("" = today)'),
        party: entity('Customer or supplier'),
        payment_mode: { type: 'string', enum: ['CASH', 'BANK', 'CREDIT', 'UNSPECIFIED'] },
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['entity', 'quantity', 'unit', 'rate'],
            properties: {
              entity: entity('Stock item'),
              quantity: spokenNumber('Quantity'),
              unit: text('Unit as said'),
              rate: spokenNumber('Price per unit'),
            },
          },
        },
        other_ledger: entity('Expense, income or bank ledger for payments, receipts and contra'),
        amount: spokenNumber('Total amount the user stated'),
        amount_includes_tax: { type: 'string', enum: ['YES', 'NO', 'NOT_SAID'] },
        gst_rate_percent: text('GST rate as said, e.g. "18"'),
        bill_no: text("The supplier's bill or invoice number, for purchases"),
        narration: text('Note to keep with the voucher'),
        missing: { type: 'array', items: { type: 'string' }, description: 'Required fields the user did not say' },
      },
    },
  },
  {
    name: 'query_outstanding',
    description: 'Answer how much a party owes us, or we owe them.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['side', 'party', 'period'],
      properties: {
        side: { type: 'string', enum: ['RECEIVABLE', 'PAYABLE'] },
        party: entity('The party asked about'),
        period: { type: 'string', enum: PERIODS },
      },
    },
  },
  {
    name: 'query_report',
    description: 'Answer a question about totals or balances.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['metric', 'period'],
      properties: {
        metric: { type: 'string', enum: ['SALES_TOTAL', 'PURCHASE_TOTAL', 'GST_PAYABLE', 'CASH_BALANCE', 'BANK_BALANCE', 'NET_PROFIT', 'RECEIVABLES_TOTAL', 'PAYABLES_TOTAL'] },
        period: { type: 'string', enum: PERIODS },
      },
    },
  },
  {
    name: 'navigate',
    description: 'Open a report or screen.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['screen', 'period', 'ledger'],
      properties: {
        screen: { type: 'string', enum: ['DAYBOOK', 'TRIAL_BALANCE', 'PROFIT_LOSS', 'BALANCE_SHEET', 'LEDGER', 'AGEING_RECEIVABLE', 'AGEING_PAYABLE', 'STOCK_SUMMARY', 'GST_SUMMARY', 'REVIEW_QUEUE', 'DASHBOARD'] },
        period: { type: 'string', enum: [...PERIODS, 'UNSPECIFIED'] },
        ledger: entity('Ledger or party, for a ledger statement'),
      },
    },
  },
  {
    name: 'reverse_voucher',
    description: 'Cancel (reverse) a posted voucher. Only when the user explicitly asks.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['voucher_type', 'voucher_no'],
      properties: {
        voucher_type: { type: 'string', enum: ['SALES', 'PURCHASE', 'PAYMENT', 'RECEIPT', 'CONTRA', 'JOURNAL', 'CREDIT_NOTE', 'DEBIT_NOTE'] },
        voucher_no: text('Voucher number if said ("" = the most recent one)'),
      },
    },
  },
  {
    name: 'clarify',
    description: 'Ask the user one short question.',
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['question'],
      properties: { question: { type: 'string' } },
    },
  },
];

const TEXT_FIELDS = new Set(['date', 'unit', 'gst_rate_percent', 'bill_no', 'narration', 'voucher_no']);

/** Tool input as the model sends it -> the app's shape, where anything not said is null. Nulls pass through. */
export function normalizeToolInput(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => normalizeToolInput(v));
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if ('spoken' in o && 'candidate_id' in o) {
      return !o.spoken && !o.candidate_id ? null : { candidate_id: o.candidate_id || null, spoken: String(o.spoken ?? '') };
    }
    if ('spoken' in o && 'value' in o) return o.value ? { value: o.value, spoken: String(o.spoken ?? '') } : null;
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, normalizeToolInput(v, k)]));
  }
  if (key === 'amount_includes_tax' && typeof value === 'string') return value === 'YES' ? true : value === 'NO' ? false : null;
  if (TEXT_FIELDS.has(key) && value === '') return null;
  return value;
}

export interface EntityRef { candidate_id: string | null; spoken: string }
export interface SpokenNumber { value: string; spoken: string }
export interface RecordVoucherCall {
  voucher_type: 'SALES' | 'PURCHASE' | 'PAYMENT' | 'RECEIPT' | 'CONTRA' | 'JOURNAL' | 'CREDIT_NOTE' | 'DEBIT_NOTE';
  date: string | null;
  party: EntityRef | null;
  payment_mode: 'CASH' | 'BANK' | 'CREDIT' | 'UNSPECIFIED';
  items: { entity: EntityRef | null; quantity: SpokenNumber | null; unit: string | null; rate: SpokenNumber | null }[];
  other_ledger: EntityRef | null;
  amount: SpokenNumber | null;
  amount_includes_tax: boolean | null;
  gst_rate_percent: string | null;
  /** Supplier's bill number (purchases); older sessions may not have it. */
  bill_no?: string | null;
  narration: string | null;
  missing: string[];
}
