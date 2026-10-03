import fs from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PGlite } from '@electric-sql/pglite';
import { many, maybeOne, one } from '../db/client';
import { config } from '../config';
import { AppError, invalid, notFound } from '../lib/errors';
import { fyStart, todayIST } from '../lib/dates';
import { STATES, isValidGstin } from '../lib/gstin';
import { toMinor } from '../lib/money';
import { createGroup, createItem, createLedger, createParty, listGroups, setOpeningBalance } from '../ledger/masters';
import { alterVoucher, postVoucher, previewVoucher, reverseVoucher, verifyChain, type Source } from '../ledger/post';
import { balanceSheet, profitAndLoss, trialBalance } from '../reports/financials';
import { ageing, daybook, ledgerStatement, openBills, voucherDetail } from '../reports/registers';
import { gstSummary } from '../reports/gst';
import { dashboard } from '../reports/dashboard';
import { stockAsOf } from '../inventory/stock';
import { acceptDocument, documentFilePath, enqueue, ingestDocument, rejectDocument } from '../ai/documents';
import { resolveParty } from '../ai/resolver';
import { cancelSession, confirmSession, handleUtterance } from '../ai/voice/engine';
import { asLang } from '../ai/voice/i18n';
import { requireUser } from '../auth/routes';

type Req = FastifyRequest<{ Params: Record<string, string>; Querystring: Record<string, string | undefined>; Body: any }>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (req: Req): any => (req.body as any) ?? {};

const date = (v: string | undefined, fallback: string) => {
  const d = v ?? fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw invalid(`Bad date: ${d}`);
  return d;
};

export function registerRoutes(app: FastifyInstance, db: PGlite) {
  /** The logged-in user (the onRequest hook has already rejected anonymous calls). */
  const uid = (req: Req) => requireUser(req).id;

  /** The company in the URL, only if the logged-in user is a member; otherwise it does not exist for them. */
  async function company(req: Req) {
    const user = requireUser(req);
    const c = await maybeOne<{ id: string; fy_start_month: number }>(db,
      `SELECT c.id, c.fy_start_month FROM companies c JOIN company_members m ON m.company_id = c.id
        WHERE c.id = $1 AND m.user_id = $2`, [req.params.cid, user.id]);
    if (!c) throw notFound('Company');
    return c;
  }

  app.get('/api/v1/status', async () => {
    const hasUsers = Boolean(await maybeOne(db, 'SELECT 1 FROM users LIMIT 1'));
    return {
      app: 'Kannaku AI', aiEnabled: config.aiEnabled, model: config.model, today: todayIST(), states: STATES, hasUsers,
      // Before the first sign-up only: books already on this machine, which the first account will own.
      unclaimed: hasUsers ? [] : (await many<{ name: string }>(db, 'SELECT name FROM companies ORDER BY created_at')).map((r) => r.name),
    };
  });

  app.patch('/api/v1/companies/:cid', async (req: Req) => {
    const c = await company(req);
    const b = body(req);
    if (b.lockDate !== undefined) await db.query(`UPDATE companies SET lock_date = $2 WHERE id = $1`, [c.id, b.lockDate || null]);
    if (b.voiceLimit !== undefined) await db.query(`UPDATE companies SET voice_limit_minor = $2 WHERE id = $1`, [c.id, toMinor(b.voiceLimit)]);
    if (b.roundInvoice !== undefined) await db.query(`UPDATE companies SET round_invoice = $2 WHERE id = $1`, [c.id, Boolean(b.roundInvoice)]);
    if (b.gstin !== undefined) {
      if (b.gstin && !isValidGstin(b.gstin)) throw invalid('GSTIN is not valid');
      await db.query(`UPDATE companies SET gstin = $2 WHERE id = $1`, [c.id, b.gstin || null]);
    }
    return { ok: true };
  });

  const P = '/api/v1/companies/:cid';

  app.get(`${P}/dashboard`, async (req: Req) => dashboard(db, (await company(req)).id));

  // ---------- Masters ----------
  app.get(`${P}/groups`, async (req: Req) => listGroups(db, (await company(req)).id));
  app.post(`${P}/groups`, async (req: Req) => createGroup(db, (await company(req)).id, body(req)));

  app.get(`${P}/ledgers`, async (req: Req) => {
    const c = await company(req);
    return many(db,
      `SELECT l.id, l.name, g.name AS "groupName", g.id AS "groupId", g.path::text AS path, g.nature, l.system_code AS "systemCode",
              l.counterparty_id AS "counterpartyId", l.bill_wise AS "billWise", l.tax_component AS "taxComponent",
              (g.path ~ '*.bank_accounts|cash_in_hand|bank_od.*') AS "isCashBank",
              COALESCE((SELECT SUM(e.amount_minor) FROM ledger_entries e WHERE e.ledger_id = l.id), 0)::bigint AS "balanceMinor"
         FROM ledgers l JOIN ledger_groups g ON g.id = l.group_id
        WHERE l.company_id = $1 AND l.is_active ORDER BY l.name`, [c.id]);
  });
  app.post(`${P}/ledgers`, async (req: Req) => createLedger(db, (await company(req)).id, body(req), uid(req)));
  app.post(`${P}/ledgers/:id/opening`, async (req: Req) => {
    const c = await company(req);
    const amt = toMinor(body(req).amount ?? '0') * (body(req).side === 'CR' ? -1n : 1n);
    return setOpeningBalance(db, c.id, req.params.id, amt, uid(req));
  });

  app.get(`${P}/parties`, async (req: Req) => {
    const c = await company(req);
    return many(db,
      `SELECT cp.id, cp.legal_name AS name, cp.gstin, cp.state_code AS "stateCode", cp.city, cp.phone, cp.credit_days AS "creditDays",
              cp.status, l.id AS "ledgerId", g.name AS "groupName",
              CASE WHEN g.path ~ '*.sundry_debtors.*' THEN 'CUSTOMER' WHEN g.path ~ '*.sundry_creditors.*' THEN 'SUPPLIER' ELSE 'OTHER' END AS kind,
              COALESCE((SELECT SUM(e.amount_minor) FROM ledger_entries e WHERE e.ledger_id = l.id), 0)::bigint AS "balanceMinor"
         FROM counterparties cp JOIN ledgers l ON l.counterparty_id = cp.id JOIN ledger_groups g ON g.id = l.group_id
        WHERE cp.company_id = $1 ORDER BY cp.legal_name`, [c.id]);
  });
  app.post(`${P}/parties`, async (req: Req) => createParty(db, (await company(req)).id, body(req), uid(req)));
  app.get(`${P}/parties/match`, async (req: Req) => resolveParty(db, (await company(req)).id, { name: req.query.name ?? null, gstin: req.query.gstin ?? null }));

  app.get(`${P}/items`, async (req: Req) => {
    const c = await company(req);
    return many(db,
      `SELECT i.id, i.name, i.hsn_sac AS "hsnSac", i.gst_rate_ppm AS "gstRatePpm", i.valuation, u.symbol AS uom, u.id AS "uomId",
              COALESCE((SELECT SUM(qty) FROM inventory_entries ie WHERE ie.item_id = i.id), 0)::text AS "qtyOnHand"
         FROM stock_items i JOIN uoms u ON u.id = i.base_uom_id WHERE i.company_id = $1 ORDER BY i.name`, [c.id]);
  });
  app.post(`${P}/items`, async (req: Req) => createItem(db, (await company(req)).id, body(req), uid(req)));
  app.get(`${P}/uoms`, async (req: Req) => many(db, `SELECT id, symbol, uqc, decimals FROM uoms WHERE company_id = $1 ORDER BY symbol`, [(await company(req)).id]));
  app.get(`${P}/godowns`, async (req: Req) => many(db, `SELECT id, name, is_default AS "isDefault" FROM godowns WHERE company_id = $1 ORDER BY name`, [(await company(req)).id]));

  // ---------- Vouchers ----------
  app.post(`${P}/vouchers/preview`, async (req: Req) => previewVoucher(db, (await company(req)).id, body(req)));
  app.post(`${P}/vouchers`, async (req: Req) => {
    const c = await company(req);
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key) throw invalid('Idempotency-Key header is required');
    return postVoucher(db, c.id, body(req), { source: 'MANUAL', idempotencyKey: key, userId: uid(req) });
  });
  app.get(`${P}/vouchers`, async (req: Req) => {
    const c = await company(req);
    const today = todayIST();
    return daybook(db, c.id, date(req.query.from, today), date(req.query.to, today), { type: req.query.type, partyId: req.query.party });
  });
  app.get(`${P}/vouchers/:id`, async (req: Req) => voucherDetail(db, (await company(req)).id, req.params.id));
  app.post(`${P}/vouchers/:id/reverse`, async (req: Req) => {
    const c = await company(req);
    return reverseVoucher(db, c.id, req.params.id, { userId: uid(req), source: 'MANUAL', date: body(req).date });
  });
  app.post(`${P}/vouchers/:id/alter`, async (req: Req) => {
    const c = await company(req);
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key) throw invalid('Idempotency-Key header is required');
    return alterVoucher(db, c.id, req.params.id, body(req), { source: 'MANUAL', idempotencyKey: key, userId: uid(req) });
  });
  app.get(`${P}/bills/open`, async (req: Req) => openBills(db, (await company(req)).id, req.query.ledgerId ?? ''));

  // Drafts (manual "save for later" and the AI write path)
  app.get(`${P}/drafts`, async (req: Req) => many(db,
    `SELECT id, payload, source, status, created_at AS "createdAt" FROM voucher_drafts
      WHERE company_id = $1 AND status = 'OPEN' AND source = 'MANUAL' ORDER BY created_at DESC`, [(await company(req)).id]));
  app.post(`${P}/drafts`, async (req: Req) => one(db,
    `INSERT INTO voucher_drafts (company_id, payload, source, created_by) VALUES ($1,$2,'MANUAL',$3) RETURNING id`,
    [(await company(req)).id, JSON.stringify(body(req)), uid(req)]));
  app.post(`${P}/drafts/:id/post`, async (req: Req) => {
    const c = await company(req);
    const d = await maybeOne<{ payload: unknown; source: Source; status: string }>(db, `SELECT payload, source, status FROM voucher_drafts WHERE id = $1 AND company_id = $2`, [req.params.id, c.id]);
    if (!d) throw notFound('Draft');
    if (d.status !== 'OPEN') throw new AppError('DRAFT_CLOSED', 409, `Draft is ${d.status.toLowerCase()}`);
    return postVoucher(db, c.id, { ...(d.payload as object), ...(body(req)) }, { source: d.source, idempotencyKey: `draft:${req.params.id}`, userId: uid(req), draftId: req.params.id });
  });

  // ---------- Reports ----------
  app.get(`${P}/reports/trial-balance`, async (req: Req) => trialBalance(db, (await company(req)).id, date(req.query.as_of, todayIST())));
  app.get(`${P}/reports/profit-loss`, async (req: Req) => {
    const c = await company(req);
    const to = date(req.query.to, todayIST());
    return profitAndLoss(db, c.id, date(req.query.from, fyStart(to, c.fy_start_month)), to);
  });
  app.get(`${P}/reports/balance-sheet`, async (req: Req) => balanceSheet(db, (await company(req)).id, date(req.query.as_of, todayIST())));
  app.get(`${P}/reports/ageing`, async (req: Req) => ageing(db, (await company(req)).id, req.query.side === 'payable' ? 'payable' : 'receivable', date(req.query.as_of, todayIST())));
  app.get(`${P}/reports/ledger/:ledgerId`, async (req: Req) => {
    const c = await company(req);
    const to = date(req.query.to, todayIST());
    return ledgerStatement(db, c.id, req.params.ledgerId, date(req.query.from, fyStart(to, c.fy_start_month)), to);
  });
  app.get(`${P}/reports/stock-summary`, async (req: Req) => stockAsOf(db, (await company(req)).id, date(req.query.as_of, todayIST())));
  app.get(`${P}/reports/gst-summary`, async (req: Req) => {
    const c = await company(req);
    const to = date(req.query.to, todayIST());
    return gstSummary(db, c.id, date(req.query.from, `${to.slice(0, 7)}-01`), to);
  });
  app.get(`${P}/audit/verify-chain`, async (req: Req) => verifyChain(db, (await company(req)).id));

  // ---------- Bill scanning ----------
  app.post(`${P}/documents`, async (req: Req) => {
    const c = await company(req);
    const results: unknown[] = [];
    for await (const part of req.files()) {
      const data = await part.toBuffer();
      try {
        results.push({ fileName: part.filename, ...(await ingestDocument(db, c.id, { name: part.filename, mime: part.mimetype, data }, uid(req))) });
      } catch (e) {
        if (e instanceof AppError) results.push({ fileName: part.filename, error: { code: e.code, message: e.message, details: e.details } });
        else throw e;
      }
    }
    return results;
  });
  app.get(`${P}/documents`, async (req: Req) => many(db,
    `SELECT d.id, d.file_name AS "fileName", d.mime, d.status, d.error, d.created_at AS "createdAt", d.voucher_id AS "voucherId",
            d.extraction->'supplier'->'name'->>'value' AS supplier, d.extraction->'invoice_number'->>'value' AS "invoiceNo",
            d.extraction->'totals'->'grand_total'->>'value' AS "grandTotal",
            (SELECT COUNT(*) FROM jsonb_array_elements(COALESCE(d.validation, '[]'::jsonb)) x WHERE x->>'severity' = 'error')::int AS errors
       FROM documents d WHERE d.company_id = $1 ORDER BY d.created_at DESC LIMIT 200`, [(await company(req)).id]));
  app.get(`${P}/documents/:id`, async (req: Req) => {
    const c = await company(req);
    const d = await maybeOne<Record<string, unknown>>(db,
      `SELECT d.id, d.file_name AS "fileName", d.mime, d.status, d.error, d.extraction, d.validation, d.matches,
              d.voucher_id AS "voucherId", d.model, d.prompt_version AS "promptVersion", vd.payload AS draft
         FROM documents d LEFT JOIN voucher_drafts vd ON vd.id = d.draft_id WHERE d.id = $1 AND d.company_id = $2`, [req.params.id, c.id]);
    if (!d) throw notFound('Document');
    return d;
  });
  app.get(`${P}/documents/:id/file`, async (req: Req, reply) => {
    const c = await company(req);
    const d = await maybeOne<{ storage_key: string; mime: string }>(db, `SELECT storage_key, mime FROM documents WHERE id = $1 AND company_id = $2`, [req.params.id, c.id]);
    if (!d) throw notFound('Document');
    reply.header('Content-Type', d.mime);
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(fs.createReadStream(documentFilePath(d.storage_key)));
  });
  app.post(`${P}/documents/:id/accept`, async (req: Req) => acceptDocument(db, (await company(req)).id, req.params.id, body(req), uid(req)));
  app.post(`${P}/documents/:id/reject`, async (req: Req) => { await rejectDocument(db, (await company(req)).id, req.params.id); return { ok: true }; });
  app.post(`${P}/documents/:id/retry`, async (req: Req) => {
    await company(req);
    enqueue(db, req.params.id);
    return { ok: true };
  });

  // ---------- Voice ----------
  app.post(`${P}/voice/utterance`, async (req: Req) => {
    const c = await company(req);
    const b = body(req);
    if (typeof b.transcript !== 'string') throw invalid('transcript is required');
    return handleUtterance(db, c.id, { transcript: b.transcript.slice(0, 2000), confidence: b.confidence ?? null, sessionId: b.sessionId ?? null, screen: b.screen ?? null, lang: asLang(b.lang), userId: uid(req) });
  });
  app.post(`${P}/voice/sessions/:id/confirm`, async (req: Req) => confirmSession(db, (await company(req)).id, req.params.id, body(req).channel === 'screen' ? 'screen' : 'voice', asLang(body(req).lang), uid(req)));
  app.post(`${P}/voice/sessions/:id/cancel`, async (req: Req) => cancelSession(db, (await company(req)).id, req.params.id, asLang(body(req).lang)));
}
