import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { computeGst } from '../src/tax/india-gst';
import { isValidGstin, makeGstin } from '../src/lib/gstin';
import { amountInWords, formatINR, fromMinor, percentToPpm, toMinor } from '../src/lib/money';
import { closingFifo, closingMovingAverage, NegativeStockError } from '../src/inventory/valuation';
import { resolvePeriod } from '../src/lib/dates';
import { normName } from '../src/lib/text';

const d = (n: number | string) => new Decimal(n);

describe('GST engine', () => {
  it('splits Rs 5,500 inclusive of 18% intra-state exactly (spec example)', () => {
    const r = computeGst([{ lineNo: 1, amountMinor: 550000n, ratePpm: 180000 }],
      { supplierState: '27', placeOfSupply: '27', pricesIncludeTax: true, roundToRupee: true });
    expect(r.taxableMinor).toBe(466102n);
    expect(r.taxes.map((t) => [t.component, t.taxMinor])).toEqual([['CGST', 41949n], ['SGST', 41949n]]);
    expect(r.roundOffMinor).toBe(0n);
    expect(r.grandTotalMinor).toBe(550000n);
  });

  it('charges IGST inter-state and UTGST in a UT without legislature', () => {
    const inter = computeGst([{ lineNo: 1, amountMinor: 3400000n, ratePpm: 180000 }],
      { supplierState: '27', placeOfSupply: '29', pricesIncludeTax: false, roundToRupee: true });
    expect(inter.taxes).toHaveLength(1);
    expect(inter.taxes[0]).toMatchObject({ component: 'IGST', taxMinor: 612000n });
    const ut = computeGst([{ lineNo: 1, amountMinor: 10000n, ratePpm: 50000 }],
      { supplierState: '04', placeOfSupply: '04', pricesIncludeTax: false, roundToRupee: false });
    expect(ut.taxes.map((t) => t.component)).toEqual(['CGST', 'UTGST']);
  });

  it('rounds the invoice to the rupee through round-off', () => {
    const r = computeGst([{ lineNo: 1, amountMinor: 10033n, ratePpm: 180000 }],
      { supplierState: '27', placeOfSupply: '27', pricesIncludeTax: false, roundToRupee: true });
    // 100.33 + 9.03 + 9.03 = 118.39 -> 118.00
    expect(r.grandTotalMinor).toBe(11800n);
    expect(r.roundOffMinor).toBe(-39n);
  });
});

describe('GSTIN', () => {
  it('generates and validates check digits', () => {
    const g = makeGstin('27', 'AAPFB1234C');
    expect(isValidGstin(g)).toBe(true);
    const wrong = g.slice(0, 14) + (g[14] === 'A' ? 'B' : 'A');
    expect(isValidGstin(wrong)).toBe(false);
    expect(isValidGstin('27AAPFB1234C1Z')).toBe(false);
  });
});

describe('money', () => {
  it('converts and formats', () => {
    expect(toMinor('5,500'.replace(',', ''))).toBe(550000n);
    expect(toMinor('0.005')).toBe(1n);
    expect(fromMinor(-12345n)).toBe('-123.45');
    expect(formatINR(1234567850n)).toBe('1,23,45,678.50');
    expect(percentToPpm('0.25')).toBe(2500);
    expect(amountInWords(550000n)).toBe('five thousand five hundred rupees');
    expect(amountInWords(15000098n)).toBe('one lakh fifty thousand rupees and ninety-eight paise');
  });
});

describe('valuation', () => {
  const moves = [
    { qty: d(10), unitCost: d(100) },
    { qty: d(10), unitCost: d(120) },
    { qty: d(-15), unitCost: null },
  ];
  it('FIFO consumes the oldest layer first', () => {
    const c = closingFifo(moves);
    expect(c.qty.toString()).toBe('5');
    expect(c.value.toString()).toBe('600');
  });
  it('moving average values at the running average', () => {
    const c = closingMovingAverage(moves);
    expect(c.qty.toString()).toBe('5');
    expect(c.value.toString()).toBe('550');
  });
  it('refuses negative stock unless allowed', () => {
    expect(() => closingFifo([{ qty: d(-1), unitCost: null }])).toThrow(NegativeStockError);
  });
});

describe('periods', () => {
  it('resolves Indian FY quarters', () => {
    expect(resolvePeriod('THIS_QUARTER', '2026-10-03')).toMatchObject({ from: '2026-10-01', to: '2026-10-03' });
    expect(resolvePeriod('LAST_QUARTER', '2026-10-03')).toMatchObject({ from: '2026-07-01', to: '2026-09-30' });
    expect(resolvePeriod('THIS_FY', '2026-02-10')).toMatchObject({ from: '2025-04-01' });
    expect(resolvePeriod('LAST_MONTH', '2026-03-15')).toMatchObject({ from: '2026-02-01', to: '2026-02-28' });
  });
});

describe('names', () => {
  it('normalises business names', () => {
    expect(normName('M/s. Shree Balaji Cement Agency Pvt. Ltd.')).toBe('shree balaji cement agency');
    expect(normName('Sharma & Sons')).toBe('sharma and sons');
  });
});

void toMinor;
