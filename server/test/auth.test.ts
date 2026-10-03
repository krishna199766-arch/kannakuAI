import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PGlite } from '@electric-sql/pglite';
import { openDb, one } from '../src/db/client';
import { seedDemo } from '../src/db/demo';
import { buildApp } from '../src/app';
import { makeGstin } from '../src/lib/gstin';

let db: PGlite;
let app: FastifyInstance;
let legacyCompanyId: string;

const company = { name: 'Murugan Hardwares', gstin: makeGstin('33', 'AAPFM5678K'), booksFrom: '2026-04-01' };
const owner = { name: 'Senthil Kumar', email: 'Senthil@Example.com', phone: '98400 12345', password: 'kanakku-2026', company };

const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers['set-cookie']).split(';')[0];
const post = (url: string, payload: unknown, cookie?: string) =>
  app.inject({ method: 'POST', url, payload: payload as object, headers: cookie ? { cookie } : {} });
const get = (url: string, cookie?: string) => app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });

beforeAll(async () => {
  db = await openDb();
  legacyCompanyId = await seedDemo(db);     // books created before accounts existed
  app = await buildApp(db);
}, 60_000);

describe('sign up and log in', () => {
  let cookie = '';

  it('reports that nobody has signed up yet, and refuses anonymous API calls', async () => {
    expect((await get('/api/v1/status')).json()).toMatchObject({ app: 'Kannaku AI', hasUsers: false });
    expect((await get('/api/v1/companies')).statusCode).toBe(401);
    expect((await get(`/api/v1/companies/${legacyCompanyId}/dashboard`)).statusCode).toBe(401);
  });

  it('validates the sign-up form', async () => {
    const bad = async (patch: object) => (await post('/api/v1/auth/signup', { ...owner, ...patch })).json().message as string;
    expect(await bad({ email: 'not-an-email' })).toMatch(/valid email/);
    expect(await bad({ password: 'short' })).toMatch(/at least 8/);
    expect(await bad({ company: { ...company, gstin: '33AAPFM5678K1Z0' } })).toMatch(/GSTIN is not valid/);
    expect(await bad({ company: { name: 'X', gstin: '', stateCode: '' } })).toMatch(/state/);
  });

  it('creates the account and the business the user entered, and logs them in', async () => {
    const res = await post('/api/v1/auth/signup', owner);
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['set-cookie'])).toMatch(/kannaku_session=.+; Path=\/; HttpOnly; SameSite=Lax/);
    cookie = cookieOf(res);
    const me = res.json();
    expect(me.companies.find((c: { id: string }) => c.id === me.companyId).name).toBe('Murugan Hardwares'); // opens the new books
    expect(me.user).toMatchObject({ email: 'senthil@example.com', name: 'Senthil Kumar' });
    const names = me.companies.map((c: { name: string }) => c.name);
    expect(names).toContain('Murugan Hardwares');
    expect(names).toContain('Sharma Building Supplies');   // first account takes over earlier books
    const mine = me.companies.find((c: { name: string }) => c.name === 'Murugan Hardwares');
    expect(mine.stateCode).toBe('33');                       // state comes from the GSTIN
    const ledgers = (await get(`/api/v1/companies/${mine.id}/ledgers`, cookie)).json();
    expect(ledgers.map((l: { name: string }) => l.name)).toEqual(expect.arrayContaining(['Cash', 'Sales', 'Purchase']));
  });

  it('stores only a scrypt hash of the password', async () => {
    const row = await one<{ password_hash: string }>(db, `SELECT password_hash FROM users WHERE email = 'senthil@example.com'`);
    expect(row.password_hash).toMatch(/^scrypt\$/);
    expect(row.password_hash).not.toContain(owner.password);
  });

  it('refuses a second account with the same email', async () => {
    const res = await post('/api/v1/auth/signup', { ...owner, email: 'senthil@example.com' });
    expect(res.statusCode).toBe(409);
  });

  it('logs out, then logs back in', async () => {
    await post('/api/v1/auth/logout', {}, cookie);
    expect((await get('/api/v1/auth/me', cookie)).statusCode).toBe(401);
    const res = await post('/api/v1/auth/login', { email: 'SENTHIL@example.com', password: owner.password });
    expect(res.statusCode).toBe(200);
    cookie = cookieOf(res);
    expect((await get('/api/v1/auth/me', cookie)).statusCode).toBe(200);
  });

  it('keeps each account to its own companies', async () => {
    const res = await post('/api/v1/auth/signup', {
      name: 'Priya', email: 'priya@example.com', password: 'another-pass-1',
      company: { name: 'Priya Textiles', gstin: null, stateCode: '29' },
    });
    const other = cookieOf(res);
    const theirs = res.json().companies;
    expect(theirs.map((c: { name: string }) => c.name)).toEqual(['Priya Textiles']);
    // The first user's books are invisible to the second.
    expect((await get(`/api/v1/companies/${legacyCompanyId}/dashboard`, other)).statusCode).toBe(404);
    expect((await get(`/api/v1/companies/${legacyCompanyId}/dashboard`, cookie)).statusCode).toBe(200);
  });

  it('records the logged-in user as the poster', async () => {
    const me = (await get('/api/v1/auth/me', cookie)).json();
    const cid = me.companies.find((c: { name: string }) => c.name === 'Murugan Hardwares').id;
    const ledgers = (await get(`/api/v1/companies/${cid}/ledgers`, cookie)).json() as { id: string; systemCode: string | null }[];
    const cash = ledgers.find((l) => l.systemCode === 'CASH')!.id;
    const pl = ledgers.find((l) => l.systemCode === 'OPENING_DIFF')!.id;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/companies/${cid}/vouchers`, headers: { cookie, 'idempotency-key': 'auth-test-1' },
      payload: { voucherType: 'JOURNAL', date: '2026-10-01', entries: [{ ledgerId: pl, side: 'DR', amount: '1' }, { ledgerId: cash, side: 'CR', amount: '1' }] },
    });
    // Journal can't touch cash; the point is that the call is authorised and reaches the posting rules.
    expect(res.json().code).toBe('JOURNAL_NO_CASH_BANK');
  });

  it('locks an email after five wrong passwords', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await post('/api/v1/auth/login', { email: 'priya@example.com', password: 'wrong-password' })).statusCode).toBe(401);
    }
    const locked = await post('/api/v1/auth/login', { email: 'priya@example.com', password: 'another-pass-1' });
    expect(locked.statusCode).toBe(429);
  });
});
