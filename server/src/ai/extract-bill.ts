import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from '../config';
import { claude, FALLBACK, loadPrompt, ModelStopped, wrapApiError } from './anthropic';
import { ParsedBill } from './bill-schema';

export const BILL_PROMPT = 'bill_extraction.v1';

export type BillMedia = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'application/pdf';
export const BILL_MEDIA = new Set<string>(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);

export async function extractBill(file: Buffer, mime: BillMedia, company: { name: string; gstin: string | null; state_code: string }, vendorHints?: string | null): Promise<ParsedBill> {
  const system = loadPrompt(BILL_PROMPT);
  const data = file.toString('base64');
  const media = mime === 'application/pdf'
    ? { type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf' as const, data } }
    : { type: 'image' as const, source: { type: 'base64' as const, media_type: mime, data } };

  let context = `Receiving company: ${company.name}, GSTIN ${company.gstin ?? 'not registered'}, state code ${company.state_code}.`;
  if (vendorHints) context += `\n<layout_notes_from_past_corrections>\n${vendorHints}\n</layout_notes_from_past_corrections>`;

  try {
    const resp = await claude().beta.messages.create({
      model: config.model,
      max_tokens: 16000,
      ...FALLBACK,
      system: [{ type: 'text', text: system.text, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [media, { type: 'text', text: `${context}\nExtract this document.` }] }],
      output_config: { format: zodOutputFormat(ParsedBill) },
    });
    if (resp.stop_reason === 'refusal' || resp.stop_reason === 'max_tokens') throw new ModelStopped(resp.stop_reason);
    const text = resp.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return ParsedBill.parse(JSON.parse(text));
  } catch (e) {
    wrapApiError(e);
  }
}
