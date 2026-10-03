import { normalizeTranscript } from './normalize';
import type { RecordVoucherCall, SpokenNumber } from './tools';

const squash = (s: string) => s.toLowerCase().replace(/[₹,]/g, '').replace(/[^a-z0-9.%\u0900-\u097f\u0b80-\u0bff ]+/g, ' ').replace(/\s+/g, ' ').trim();

export type GroundedField = 'amount' | 'quantity' | 'rate' | 'gst_rate';
export interface GroundingProblem { path: string; field: GroundedField; message: string; ask: string }

/**
 * Every number the model returns must be traceable to the words heard (spec 4.5):
 * its cited words occur in the transcript, and our normaliser reads the same value from them.
 */
export function groundNumber(path: string, n: SpokenNumber, normalizedTranscript: string, label: GroundedField): GroundingProblem | null {
  const claimed = Number(n.value.replace(/,/g, ''));
  const ask = `Sorry, what was the ${label}?`;
  if (!Number.isFinite(claimed)) return { path, field: label, message: `${label}: "${n.value}" is not a number`, ask };
  const cited = normalizeTranscript(n.spoken);
  const haystack = squash(normalizedTranscript);
  if (!haystack.includes(squash(cited.text))) {
    return { path, field: label, message: `${label}: the words "${n.spoken}" are not in what I heard`, ask };
  }
  const heard = cited.spans.map((s) => s.value);
  if (!heard.some((v) => Math.abs(v - claimed) < 0.005)) {
    return { path, field: label, message: `${label}: ${claimed} does not match the words "${n.spoken}"`, ask };
  }
  return null;
}

export function groundRecordVoucher(call: RecordVoucherCall, normalizedTranscript: string): GroundingProblem[] {
  const problems: GroundingProblem[] = [];
  const check = (path: string, n: SpokenNumber | null, label: GroundedField) => {
    if (!n) return;
    const p = groundNumber(path, n, normalizedTranscript, label);
    if (p) problems.push(p);
  };
  check('amount', call.amount, 'amount');
  call.items.forEach((it, i) => {
    check(`items.${i}.quantity`, it.quantity, 'quantity');
    check(`items.${i}.rate`, it.rate, 'rate');
  });
  if (call.gst_rate_percent) {
    const rate = Number(call.gst_rate_percent);
    const heard = normalizeTranscript(normalizedTranscript).spans.some((s) => Math.abs(s.value - rate) < 0.005);
    if (!heard) problems.push({ path: 'gst_rate_percent', field: 'gst_rate', message: `GST rate ${rate}% was not said`, ask: 'What GST rate applies?' });
  }
  return problems;
}
