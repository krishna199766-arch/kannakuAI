import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite, types, type Transaction } from '@electric-sql/pglite';
import { ltree } from '@electric-sql/pglite/contrib/ltree';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

/** Anything we can run queries on: the database or an open transaction. */
export type Db = PGlite | Transaction;

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Opens the database. `dataDir` undefined = in-memory (tests).
 * INT8 is always parsed to BigInt so money never passes through a float.
 */
export async function openDb(dataDir?: string): Promise<PGlite> {
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const db = await PGlite.create({
    dataDir,
    extensions: { ltree, pg_trgm },
    parsers: { [types.INT8]: (v: string) => BigInt(v) },
  });
  await migrate(db);
  return db;
}

async function migrate(db: PGlite) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
  }
}

export async function one<T>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, params);
  if (r.rows.length === 0) throw new Error(`Expected one row: ${sql.slice(0, 80)}`);
  return r.rows[0];
}

export async function maybeOne<T>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await db.query<T>(sql, params);
  return r.rows[0] ?? null;
}

export async function many<T>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}
