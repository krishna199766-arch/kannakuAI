import { config } from './config';
import { openDb } from './db/client';
import { seedDemo } from './db/demo';
import { buildApp } from './app';
import { resumePending } from './ai/documents';

const db = await openDb(config.dbDir);

// Fresh installs start empty: the first visitor signs up and enters their own business.
// LEDGERAI_DEMO=1 pre-loads the sample company (it is claimed by the first account).
const companies = await db.query<{ n: bigint }>('SELECT COUNT(*)::bigint AS n FROM companies');
if (companies.rows[0].n === 0n && process.env.LEDGERAI_DEMO === '1') {
  console.log('Seeding the sample company "Sharma Building Supplies"...');
  await seedDemo(db);
}

const app = await buildApp(db, { serveWeb: true });
await resumePending(db);
await app.listen({ port: config.port, host: '127.0.0.1' });
console.log(`Kannaku AI on http://127.0.0.1:${config.port}  (AI ${config.aiEnabled ? `on, model ${config.model}` : 'off: click "AI off" in the app to add an API key'})`);

const shutdown = async () => { await app.close(); await db.close(); process.exit(0); };
// Close the embedded database cleanly on Ctrl+C, Ctrl+Break and when the terminal window is closed
// (Windows sends SIGHUP); a hard kill can leave PGlite's files half-written.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(sig, shutdown);
