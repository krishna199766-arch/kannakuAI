import type Anthropic from '@anthropic-ai/sdk';

/** Strict tool schemas (spec 4.3). Deliberately no debit/credit field anywhere. */

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });

const entity = (description: string) => nullable({
  type: 'object',
  description,
  additionalProperties: false,
  required: ['candidate_id', 'spoken'],
  properties: {
    candidate_id: { type: ['string', 'null'], description: 'A key from <candidates> (e.g. "p1"), or null if none clearly fits' },
    spoken: { type: 'string', description: 'The words the user used for it' },
  },
});

const spokenNumber = (description: string) => nullable({
  type: 'object',
  description,
  additionalProperties: false,
  required: ['value', 'spoken'],
  properties: {
    value: { type: 'string', description: 'Decimal digits, e.g. "5500"' },
    spoken: { type: 'string', description: 'Exact transcript words that state this number' },
  },
});

const PERIODS = ['TODAY', 'YESTERDAY', 'THIS_WEEK', 'THIS_MONTH', 'LAST_MONTH', 'THIS_QUARTER', 'LAST_QUARTER', 'THIS_FY', 'LAST_FY', 'AS_OF_TODAY'];

export const VOICE_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'record_voucher',
    description: "Prepare (not post) a voucher from the user's spoken instruction. Use only values the user said.",
    strict: true,
    input_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['voucher_type', 'date', 'party', 'payment_mode', 'items', 'other_ledger', 'amount', 'amount_includes_tax', 'gst_rate_percent', 'narration', 'missing'],
      properties: {
        voucher_type: { type: 'string', enum: ['SALES', 'PURCHASE', 'PAYMENT', 'RECEIPT', 'CONTRA', 'JOURNAL', 'CREDIT_NOTE', 'DEBIT_NOTE'] },
        date: { type: ['string', 'null'], description: 'YYYY-MM-DD only if the user said a date; null = today' },
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
              unit: { type: ['string', 'null'] },
              rate: spokenNumber('Price per unit'),
            },
          },
        },
        other_ledger: entity('Expense, income or bank ledger for payments, receipts and contra'),
        amount: spokenNumber('Total amount the user stated'),
        amount_includes_tax: { type: ['boolean', 'null'] },
        gst_rate_percent: { type: ['string', 'null'] },
        narration: { type: ['string', 'null'] },
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
        voucher_no: { type: ['string', 'null'], description: 'Voucher number if said; null means the most recent one' },
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
  narration: string | null;
  missing: string[];
}
