import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { AppError } from '../lib/errors';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts');

let client: Anthropic | null = null;

export function claude(): Anthropic {
  if (!config.aiEnabled) {
    throw new AppError('AI_DISABLED', 503, 'AI features need ANTHROPIC_API_KEY. Add it to .env in the project root and restart.');
  }
  client ??= new Anthropic();
  return client;
}

export function loadPrompt(name: string): { text: string; version: string } {
  return { text: fs.readFileSync(path.join(PROMPTS, `${name}.txt`), 'utf8'), version: name };
}

/** Server-side refusal fallback (routes a declined request to Anthropic's recommended model). */
export const FALLBACK = {
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default' as const,
};

export class ModelStopped extends AppError {
  constructor(reason: string | null) {
    super('MODEL_STOPPED', 502, `The model stopped without a usable answer (${reason ?? 'unknown'}).`);
  }
}

/** Translates SDK errors into API errors the UI can show. */
export function wrapApiError(e: unknown): never {
  if (e instanceof AppError) throw e;
  if (e instanceof Anthropic.RateLimitError) throw new AppError('AI_RATE_LIMITED', 429, 'The AI service is rate limiting requests. Try again in a moment.');
  if (e instanceof Anthropic.AuthenticationError) throw new AppError('AI_AUTH', 503, 'The ANTHROPIC_API_KEY was rejected.');
  if (e instanceof Anthropic.APIConnectionError) throw new AppError('AI_UNREACHABLE', 503, 'Could not reach the AI service.');
  if (e instanceof Anthropic.APIError) throw new AppError('AI_ERROR', 502, `AI service error: ${e.message}`);
  throw e;
}
