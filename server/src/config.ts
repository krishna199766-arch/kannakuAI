import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..', '..');

// Load .env from the repo root if present (Node >= 21).
try {
  process.loadEnvFile(path.join(ROOT_DIR, '.env'));
} catch {
  /* no .env file — fine */
}

const dataDir = path.resolve(ROOT_DIR, process.env.DATA_DIR ?? 'data');

export const config = {
  port: Number(process.env.PORT ?? 4000),
  dataDir,
  dbDir: path.join(dataDir, 'pg'),
  uploadDir: path.join(dataDir, 'uploads'),
  webDist: path.join(ROOT_DIR, 'web', 'dist'),
  model: process.env.LEDGERAI_MODEL ?? 'claude-opus-5-5',
  aiEnabled: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
  // Single local user until auth lands (Phase 4).
  localUserId: '00000000-0000-4000-8000-000000000001',
};
