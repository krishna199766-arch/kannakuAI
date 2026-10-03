import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance } from 'fastify';
import { openDb } from '../src/db/client';
import { buildApp } from '../src/app';
import { config } from '../src/config';
import { keyCheck } from '../src/ai/key';
import { makeGstin } from '../src/lib/gstin';

// The key is written to a throwaway .env, never the project's.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kannaku-key-'));
const envFile = path.join(dir, '.env');
const GOOD = 'sk-ant-api03-' + 'a'.repeat(40) + 'WXYZ';
let app: FastifyInstance;
let owner = '';
let viewer = '';

const req = (method: 'GET' | 'PUT' | 'DELETE', cookie: string, payload?: object) =>
  app.inject({ method, url: '/api/v1/settings/ai-key', headers: { cookie }, payload });
const signup = async (email: string) => {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload: {
    name: 'Owner', email, password: 'kanakku-2026', company: { name: `Books of ${email}`, gstin: makeGstin('33', 'AAPFM5678K'), booksFrom: '2026-04-01' },
  } });
  return String(res.headers['set-cookie']).split(';')[0];
};

beforeAll(async () => {
  config.envFile = envFile;
  fs.writeFileSync(envFile, '# my settings\nPORT=4000\nANTHROPIC_API_KEY=\n');
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  config.aiEnabled = false;
  const db = await openDb();
  app = await buildApp(db);
  owner = await signup('owner@example.com');
  viewer = await signup('second@example.com');
  // The second user only views their books: they may see the key status but not change it.
  await db.query(`UPDATE company_members SET role = 'VIEWER' WHERE user_id = (SELECT id FROM users WHERE email = 'second@example.com')`);
}, 60_000);

afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('AI key from the app', () => {
  it('starts off, and needs a login to look', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings/ai-key' })).statusCode).toBe(401);
    expect((await req('GET', owner)).json()).toMatchObject({ enabled: false, hint: null, source: null });
  });

  it('refuses something that is not a key without calling Anthropic', async () => {
    let called = false;
    keyCheck.run = async () => { called = true; };
    const res = await req('PUT', owner, { apiKey: 'hello\nANTHROPIC_AUTH_TOKEN=x' });
    expect(res.statusCode).toBe(400);
    expect(called).toBe(false);
  });

  it('reports a key Anthropic rejects, and saves nothing', async () => {
    keyCheck.run = async () => { throw new Anthropic.AuthenticationError(401, {}, 'invalid x-api-key', new Headers()); };
    const res = await req('PUT', owner, { apiKey: GOOD });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/did not accept/);
    expect(fs.readFileSync(envFile, 'utf8')).toContain('ANTHROPIC_API_KEY=\n');
    expect(config.aiEnabled).toBe(false);
  });

  it('saves a working key to .env, keeps the other lines, and turns AI on without a restart', async () => {
    keyCheck.run = async () => {};
    const res = await req('PUT', owner, { apiKey: `  ${GOOD} ` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, hint: '…WXYZ', source: 'app' });
    expect(JSON.stringify(res.json())).not.toContain(GOOD);
    expect(fs.readFileSync(envFile, 'utf8')).toBe(`# my settings\nPORT=4000\nANTHROPIC_API_KEY=${GOOD}\n`);
    expect(config.aiEnabled).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/v1/status' })).json().aiEnabled).toBe(true);
  });

  it('removes the key', async () => {
    const res = await req('DELETE', owner);
    expect(res.json()).toMatchObject({ enabled: false, hint: null });
    expect(fs.readFileSync(envFile, 'utf8')).toBe('# my settings\nPORT=4000\nANTHROPIC_API_KEY=\n');
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('lets only an owner change the key', async () => {
    expect((await req('PUT', viewer, { apiKey: GOOD })).statusCode).toBe(403);
  });

  it('does not touch a key that comes from the environment', async () => {
    process.env.ANTHROPIC_API_KEY = GOOD;
    config.aiEnabled = true;
    expect((await req('GET', viewer)).json()).toMatchObject({ source: 'environment' });
    expect((await req('DELETE', owner)).statusCode).toBe(409);
    delete process.env.ANTHROPIC_API_KEY;
    config.aiEnabled = false;
  });
});
