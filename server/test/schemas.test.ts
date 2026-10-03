import { describe, expect, it } from 'vitest';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod/v4';
import { VOICE_TOOLS } from '../src/ai/voice/tools';
import { ParsedBill } from '../src/ai/bill-schema';
import { BillWire, billFromWire } from '../src/ai/extract-bill';
import { Classification, LineDecisions, StatementExtract, WorkingsExtract } from '../src/ai/intake/llm';

/**
 * The API compiles strict tool and output schemas with limits per request; one over the limit is a 400
 * on every call. Count what each request sends, so a new nullable field fails here, not for a user.
 */
const UNION_LIMIT = 16;
type Js = Record<string, unknown>;

function unions(schema: unknown, defs: Js = {}): number {
  if (!schema || typeof schema !== 'object') return 0;
  const s = schema as Js;
  if (typeof s.$ref === 'string') return unions(defs[s.$ref.split('/').pop()!], defs);
  let n = 0;
  if (s.properties) {
    for (const p of Object.values(s.properties as Js)) {
      const ps = p as Js;
      const target = typeof ps.$ref === 'string' ? defs[ps.$ref.split('/').pop()!] as Js : ps;
      if (Array.isArray(target?.type) || target?.anyOf) n++;
      n += unions(target, defs);
    }
  }
  if (s.items) n += unions(s.items, defs);
  for (const k of ['anyOf', 'oneOf', 'allOf']) for (const b of (s[k] as unknown[] | undefined) ?? []) n += unions(b, defs);
  return n;
}
const outputSchema = (zs: z.ZodType) => {
  const f = zodOutputFormat(zs) as unknown as { schema: Js };
  return unions(f.schema, { ...(f.schema.$defs as Js ?? {}), ...(f.schema.definitions as Js ?? {}) });
};

describe('bill wire format', () => {
  it('turns the model\'s "not printed" values back into null', () => {
    const party = { name: 'Shree Traders', gstin: '', address: '', state: 'Tamil Nadu', phone: '' };
    const wire = {
      document_type: 'TAX_INVOICE', supplier: party, buyer: { ...party, name: '' }, invoice_number: 'A/01', invoice_date: '2026-10-01',
      due_date: '', place_of_supply: '', reverse_charge: 'NOT_STATED', irn: '', original_invoice_ref: '', currency: 'INR',
      line_items: [{ line_no: 1, description: 'Cement', hsn_sac: '2523', quantity: '10', uom: '', unit_price: '400', discount: '', taxable_value: '4000',
        gst_rate_percent: '28', cgst: '', sgst: '', igst: '', cess: '', line_total: '' }],
      charges: [], tax_summary: [],
      totals: { subtotal: '', discount_total: '', tax_total: '1120', round_off: '', grand_total: '5120', amount_in_words: '' },
      payment: { status: 'PAID', mode: 'NOT_STATED', amount_paid: '', reference: 'UTR1' }, warnings: [],
    };
    const app = billFromWire(wire);
    expect(app.reverse_charge).toBeNull();
    expect(app.due_date).toBeNull();
    expect(app.invoice_number).toEqual({ value: 'A/01', raw: 'A/01', page: null });
    expect(app.supplier.gstin).toEqual({ value: null, raw: null, page: null });
    expect(app.line_items[0]).toMatchObject({ uom: null, cgst: null, taxable_value: '4000' });
    expect(app.payment).toEqual({ status: 'PAID', mode: null, amount_paid: null, reference: 'UTR1' });
    expect(billFromWire({ ...wire, reverse_charge: 'YES' }).reverse_charge).toBe(true);
    expect(ParsedBill.parse(app)).toBeTruthy();
  });
});

describe('schemas stay within the API limits', () => {
  it('voice tools (all sent together)', () => {
    const total = VOICE_TOOLS.reduce((s, t) => s + unions(t.input_schema), 0);
    expect(total).toBeLessThanOrEqual(UNION_LIMIT);
  });
  it.each([
    ['bill', BillWire], ['classify', Classification], ['statement', StatementExtract], ['bank lines', LineDecisions], ['workings', WorkingsExtract],
  ] as [string, z.ZodType][])('%s output', (_name, zs) => {
    expect(outputSchema(zs)).toBeLessThanOrEqual(UNION_LIMIT);
  });
});
