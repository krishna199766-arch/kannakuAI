import { many, maybeOne, type Db } from '../db/client';
import { gstinPan, isValidGstin } from '../lib/gstin';
import { normName, normText } from '../lib/text';
import { hasTamil, transliterate } from '../lib/tamil';

/**
 * Shared entity resolver (spec 3.4) for OCR and voice. This build uses trigram similarity only;
 * the embedding term from the spec slots into `score` once an embedding model is configured.
 */
export const AUTO_ACCEPT = 0.8;
export const AUTO_MARGIN = 0.1;
export const SUGGEST_MIN = 0.35;

export interface PartyCandidate { id: string; name: string; ledgerId: string; gstin: string | null; city: string | null; score: number }
export interface PartyResolution {
  status: 'MATCHED' | 'SUGGEST' | 'NEW';
  reason: string;
  match: PartyCandidate | null;
  candidates: PartyCandidate[];
  samePan: PartyCandidate | null;
}

const partySelect = `SELECT c.id, c.legal_name AS name, l.id AS "ledgerId", c.gstin, c.city`;

export async function resolveParty(db: Db, companyId: string, q: { name: string | null; gstin: string | null }): Promise<PartyResolution> {
  const gstin = q.gstin?.replace(/\s/g, '').toUpperCase() ?? null;
  if (gstin && isValidGstin(gstin)) {
    const exact = await maybeOne<PartyCandidate>(db,
      `${partySelect}, 1.0::float8 AS score FROM counterparties c JOIN ledgers l ON l.counterparty_id = c.id
        WHERE c.company_id = $1 AND c.gstin = $2`, [companyId, gstin]);
    if (exact) return { status: 'MATCHED', reason: 'GSTIN match', match: exact, candidates: [exact], samePan: null };
  }
  let samePan: PartyCandidate | null = null;
  if (gstin && isValidGstin(gstin)) {
    samePan = await maybeOne<PartyCandidate>(db,
      `${partySelect}, 0.9::float8 AS score FROM counterparties c JOIN ledgers l ON l.counterparty_id = c.id
        WHERE c.company_id = $1 AND c.pan = $2 LIMIT 1`, [companyId, gstinPan(gstin)]);
  }
  if (!q.name) return { status: 'NEW', reason: 'No name on the document', match: null, candidates: [], samePan };
  const n = normName(q.name);
  const alias = await maybeOne<PartyCandidate>(db,
    `${partySelect}, 0.98::float8 AS score FROM party_aliases a JOIN counterparties c ON c.id = a.counterparty_id
       JOIN ledgers l ON l.counterparty_id = c.id WHERE a.company_id = $1 AND a.alias_norm = $2`, [companyId, n]);
  if (alias && !gstin) return { status: 'MATCHED', reason: 'Learned alias', match: alias, candidates: [alias], samePan };

  const candidates = await many<PartyCandidate>(db,
    `${partySelect}, similarity(c.norm_name, $2)::float8 AS score
       FROM counterparties c JOIN ledgers l ON l.counterparty_id = c.id
      WHERE c.company_id = $1 AND c.status <> 'INACTIVE' AND similarity(c.norm_name, $2) >= $3
      ORDER BY score DESC LIMIT 5`, [companyId, n, SUGGEST_MIN]);
  const [top, second] = candidates;
  // A printed GSTIN that differs from the best name match means a different registration: never auto-match.
  const gstinConflict = top && gstin && top.gstin && top.gstin !== gstin;
  if (top && !gstinConflict && top.score >= AUTO_ACCEPT && (!second || top.score - second.score >= AUTO_MARGIN)) {
    return { status: 'MATCHED', reason: `Name similarity ${top.score.toFixed(2)}`, match: top, candidates, samePan };
  }
  if (candidates.length) return { status: 'SUGGEST', reason: gstinConflict ? 'Similar name but a different GSTIN' : 'Similar names found', match: null, candidates, samePan };
  return { status: 'NEW', reason: 'No similar party', match: null, candidates: [], samePan };
}

export async function learnPartyAlias(db: Db, companyId: string, printedName: string, counterpartyId: string) {
  const n = normName(printedName);
  if (!n) return;
  await db.query(
    `INSERT INTO party_aliases (company_id, alias_norm, counterparty_id) VALUES ($1,$2,$3)
     ON CONFLICT (company_id, alias_norm) DO UPDATE SET counterparty_id = EXCLUDED.counterparty_id`, [companyId, n, counterpartyId]);
}

export interface LineResolution {
  itemId: string | null;
  itemName: string | null;
  ledgerId: string | null;
  ledgerName: string | null;
  score: number;
  reason: string;
  candidates: { id: string; name: string; score: number }[];
}

/** Vendor memory -> stock item by name (+ HSN) -> expense rules -> default ledger. */
export async function resolveLine(db: Db, companyId: string, counterpartyId: string | null, description: string, hsn: string | null): Promise<LineResolution> {
  const desc = normText(description);
  if (counterpartyId) {
    const mem = await maybeOne<{ item_id: string | null; ledger_id: string | null; item_name: string | null; ledger_name: string | null; score: number }>(db,
      `SELECT m.item_id, m.ledger_id, i.name AS item_name, l.name AS ledger_name, similarity(m.desc_norm, $3)::float8 AS score
         FROM vendor_line_memory m LEFT JOIN stock_items i ON i.id = m.item_id LEFT JOIN ledgers l ON l.id = m.ledger_id
        WHERE m.company_id = $1 AND m.counterparty_id = $2 AND similarity(m.desc_norm, $3) >= 0.85
        ORDER BY score DESC LIMIT 1`, [companyId, counterpartyId, desc]);
    if (mem) {
      return { itemId: mem.item_id, itemName: mem.item_name, ledgerId: mem.ledger_id, ledgerName: mem.ledger_name, score: mem.score, reason: 'Same supplier, same description before', candidates: [] };
    }
  }
  const items = await many<{ id: string; name: string; hsn_sac: string | null; score: number }>(db,
    `SELECT id, name, hsn_sac,
            GREATEST(word_similarity(norm_name, $2), COALESCE((SELECT MAX(word_similarity(a, $2)) FROM unnest(aliases) a), 0))::float8 AS score
       FROM stock_items WHERE company_id = $1
      ORDER BY score DESC LIMIT 5`, [companyId, desc]);
  const hsnOk = (h: string | null) => !hsn || !h || h.slice(0, 4) === hsn.slice(0, 4);
  const plausible = items.filter((i) => i.score >= 0.5 && hsnOk(i.hsn_sac));
  if (plausible[0] && plausible[0].score >= 0.7) {
    return { itemId: plausible[0].id, itemName: plausible[0].name, ledgerId: null, ledgerName: null, score: plausible[0].score, reason: 'Item name match', candidates: plausible };
  }
  const rule = EXPENSE_RULES.find((r) => (hsn && r.hsn.some((p) => hsn.startsWith(p))) || r.words.some((w) => desc.includes(w)));
  if (rule) {
    const l = await maybeOne<{ id: string; name: string }>(db,
      `SELECT id, name FROM ledgers WHERE company_id = $1 AND lower(name) = ANY($2::text[]) LIMIT 1`, [companyId, rule.ledgers]);
    if (l) return { itemId: null, itemName: null, ledgerId: l.id, ledgerName: l.name, score: 0.75, reason: 'Expense rule', candidates: plausible };
  }
  return { itemId: null, itemName: null, ledgerId: null, ledgerName: null, score: 0, reason: 'No match; uses the default Purchase ledger', candidates: plausible };
}

const EXPENSE_RULES = [
  { hsn: ['9984'], words: ['internet', 'broadband', 'mobile', 'telephone'], ledgers: ['telephone & internet', 'telephone'] },
  { hsn: ['2710'], words: ['petrol', 'diesel', 'fuel'], ledgers: ['fuel', 'vehicle fuel'] },
  { hsn: ['9965'], words: ['freight', 'transport', 'cartage'], ledgers: ['freight inward', 'freight'] },
  { hsn: ['2716'], words: ['electricity'], ledgers: ['electricity'] },
  { hsn: ['9972'], words: ['rent'], ledgers: ['rent'] },
];

export async function learnLine(db: Db, companyId: string, counterpartyId: string, description: string, itemId: string | null, ledgerId: string | null) {
  await db.query(
    `INSERT INTO vendor_line_memory (company_id, counterparty_id, desc_norm, item_id, ledger_id) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (company_id, counterparty_id, desc_norm) DO UPDATE SET item_id = EXCLUDED.item_id, ledger_id = EXCLUDED.ledger_id, updated_at = now()`,
    [companyId, counterpartyId, normText(description), itemId, ledgerId]);
}

export interface VoiceCandidates {
  parties: { key: string; id: string; name: string; group: string; city: string | null; score: number }[];
  items: { key: string; id: string; name: string; uom: string; gstRatePpm: number | null; score: number }[];
  ledgers: { key: string; id: string; name: string; group: string; score: number }[];
}

/** Up to this many of each kind are listed when trigram matching can't work (Tamil script). */
const SCRIPT_FALLBACK_LIMIT = 80;

/**
 * Names that resemble words in the utterance; short keys (p1, i1, l1) keep model output small and checkable.
 * Tamil speech recognition writes English names in Tamil script, which trigram matching against
 * English names can't see. So the transcript is transliterated first, and the remaining names are
 * appended (best matches first) for the model to match by sound.
 */
export async function voiceCandidates(db: Db, companyId: string, transcript: string): Promise<VoiceCandidates> {
  const tamil = hasTamil(transcript);
  const best = await matchCandidates(db, companyId, normName(tamil ? transliterate(transcript) : transcript));
  if (!tamil) return best;
  const rest = await many<{ kind: string; id: string; name: string; group: string; city: string | null; uom: string | null; gstRatePpm: number | null }>(db,
    `(SELECT 'party' AS kind, c.id, c.legal_name AS name, g.name AS "group", c.city, NULL AS uom, NULL::int AS "gstRatePpm"
        FROM counterparties c JOIN ledgers l ON l.counterparty_id = c.id JOIN ledger_groups g ON g.id = l.group_id
       WHERE c.company_id = $1 AND c.status <> 'INACTIVE' ORDER BY c.legal_name LIMIT $2)
     UNION ALL
     (SELECT 'item', i.id, i.name, NULL, NULL, u.symbol, i.gst_rate_ppm
        FROM stock_items i JOIN uoms u ON u.id = i.base_uom_id WHERE i.company_id = $1 ORDER BY i.name LIMIT $2)
     UNION ALL
     (SELECT 'ledger', l.id, l.name, g.name, NULL, NULL, NULL
        FROM ledgers l JOIN ledger_groups g ON g.id = l.group_id
       WHERE l.company_id = $1 AND l.counterparty_id IS NULL AND l.tax_component IS NULL ORDER BY l.name LIMIT $2)`,
    [companyId, SCRIPT_FALLBACK_LIMIT]);
  const add = <T extends { key: string; id: string }>(list: T[], prefix: string, extra: Omit<T, 'key'>[]) => {
    const seen = new Set(list.map((x) => x.id));
    const out = [...list];
    for (const e of extra) if (!seen.has(e.id)) out.push({ ...e, key: `${prefix}${out.length + 1}` } as T);
    return out;
  };
  return {
    parties: add(best.parties, 'p', rest.filter((r) => r.kind === 'party').map((r) => ({ id: r.id, name: r.name, group: r.group, city: r.city, score: 0 }))),
    items: add(best.items, 'i', rest.filter((r) => r.kind === 'item').map((r) => ({ id: r.id, name: r.name, uom: r.uom ?? '', gstRatePpm: r.gstRatePpm, score: 0 }))),
    ledgers: add(best.ledgers, 'l', rest.filter((r) => r.kind === 'ledger').map((r) => ({ id: r.id, name: r.name, group: r.group, score: 0 }))),
  };
}

async function matchCandidates(db: Db, companyId: string, t: string): Promise<VoiceCandidates> {
  const parties = await many<{ id: string; name: string; group: string; city: string | null; score: number }>(db,
    `SELECT c.id, c.legal_name AS name, g.name AS "group", c.city, word_similarity(c.norm_name, $2)::float8 AS score
       FROM counterparties c JOIN ledgers l ON l.counterparty_id = c.id JOIN ledger_groups g ON g.id = l.group_id
      WHERE c.company_id = $1 AND c.status <> 'INACTIVE' AND word_similarity(c.norm_name, $2) >= 0.45
      ORDER BY score DESC LIMIT 6`, [companyId, t]);
  const items = await many<{ id: string; name: string; uom: string; gstRatePpm: number | null; score: number }>(db,
    `SELECT i.id, i.name, u.symbol AS uom, i.gst_rate_ppm AS "gstRatePpm",
            GREATEST(word_similarity(i.norm_name, $2), COALESCE((SELECT MAX(word_similarity(a, $2)) FROM unnest(i.aliases) a), 0))::float8 AS score
       FROM stock_items i JOIN uoms u ON u.id = i.base_uom_id WHERE i.company_id = $1
      ORDER BY score DESC LIMIT 6`, [companyId, t]);
  const ledgers = await many<{ id: string; name: string; group: string; score: number }>(db,
    `SELECT l.id, l.name, g.name AS "group", word_similarity(l.norm_name, $2)::float8 AS score
       FROM ledgers l JOIN ledger_groups g ON g.id = l.group_id
      WHERE l.company_id = $1 AND l.counterparty_id IS NULL AND l.tax_component IS NULL
        AND (word_similarity(l.norm_name, $2) >= 0.5 OR g.path ~ '*.bank_accounts|cash_in_hand.*')
      ORDER BY score DESC LIMIT 8`, [companyId, t]);
  return {
    parties: parties.map((p, i) => ({ key: `p${i + 1}`, ...p })),
    items: items.filter((i) => i.score >= 0.4).map((it, i) => ({ key: `i${i + 1}`, ...it })),
    ledgers: ledgers.map((l, i) => ({ key: `l${i + 1}`, ...l })),
  };
}
