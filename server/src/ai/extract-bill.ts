import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from '../config';
import { claude, FALLBACK, loadPrompt, ModelStopped, wrapApiError } from './anthropic';
import * as z from 'zod/v4';
import { Evidence, ParsedBill } from './bill-schema';
import { fromWire, toWire, type Simplify } from './wire';

/**
 * What the model fills: the bill schema without nullable fields (API union limit), and with each
 * evidence field as one string (the full schema compiles to a grammar the API rejects as too large).
 */
const SIMPLIFY: Simplify = new Map([[Evidence as z.ZodType, {
  wire: z.string().describe('As printed, normalised (dates YYYY-MM-DD, amounts 1234.50); "" if not printed'),
  from: (v: unknown) => { const s = typeof v === 'string' && v.trim() ? v.trim() : null; return { value: s, raw: s, page: null }; },
}]]);
export const BillWire = toWire(ParsedBill, SIMPLIFY);
export const billFromWire = (out: unknown) => ParsedBill.parse(fromWire(ParsedBill, out, SIMPLIFY));

export const BILL_PROMPT = 'bill_extraction.v3';

export type BillMedia = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'application/pdf';
export const BILL_MEDIA = new Set<string>(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);

/** role: the company RECEIVED the document (purchase side) or ISSUED it (sales side). */
export async function extractBill(file: Buffer, mime: BillMedia, company: { name: string; gstin: string | null; state_code: string }, vendorHints?: string | null, role: 'received' | 'issued' = 'received'): Promise<ParsedBill> {
  const system = loadPrompt(BILL_PROMPT);
  const data = file.toString('base64');
  const media = mime === 'application/pdf'
    ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data } }
    : { type: 'image' as const, source: { type: 'base64' as const, media_type: mime, data } };

  let context = `Company: ${company.name}, GSTIN ${company.gstin ?? 'not registered'}, state code ${company.state_code}. The company ${role === 'issued' ? 'ISSUED' : 'RECEIVED'} this document.`;
  if (vendorHints) context += `\n<layout_notes_from_past_corrections>\n${vendorHints}\n</layout_notes_from_past_corrections>`;

  try {
    const resp = await claude().beta.messages.create({
      model: config.model,
      max_tokens: 16000,
      ...FALLBACK,
      system: [{ type: 'text', text: system.text, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [media, { type: 'text', text: `${context}\nExtract this document.` }] }],
      output_config: { format: zodOutputFormat(BillWire) },
    });
    if (resp.stop_reason === 'refusal' || resp.stop_reason === 'max_tokens') throw new ModelStopped(resp.stop_reason);
    const text = resp.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return billFromWire(JSON.parse(text));
  } catch (e) {
    wrapApiError(e);
  }
}
