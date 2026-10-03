/** Normalises a business name for matching (spec section 3.4). */
export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bm\s*\/\s*s\b\.?/g, ' ')
    .replace(/\bmessrs\b\.?/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(pvt|private|ltd|limited|llp|co)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lower-case, collapse whitespace, drop punctuation — for item descriptions. */
export function normText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9.% ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** JSON with object keys sorted at every level — stable across jsonb round-trips (used for hashes). */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}
