import { config } from '../config';
import { openDb, many, maybeOne } from '../db/client';
import { hashPassword } from '../auth/auth';

// Sets a new password for a local account and signs it out everywhere.
// Stop the server first: only one process may open the database at a time.
// Usage: npm run reset-password -- <email> <new password>   (no arguments lists the accounts)
const [emailRaw, password] = process.argv.slice(2);
const db = await openDb(config.dbDir);
try {
  if (!emailRaw) {
    const users = await many<{ email: string; name: string }>(db, `SELECT email, name FROM users ORDER BY created_at`);
    console.log(users.length ? users.map((u) => `${u.email}  (${u.name})`).join('\n') : 'No accounts yet.');
    console.log('\nUsage: npm run reset-password -- <email> <new password>');
  } else {
    const email = emailRaw.trim().toLowerCase();
    if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');
    const user = await maybeOne<{ id: string }>(db, `SELECT id FROM users WHERE email = $1`, [email]);
    if (!user) throw new Error(`No account for ${email}. Run without arguments to list accounts.`);
    await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [await hashPassword(password), user.id]);
    await db.query(`DELETE FROM user_sessions WHERE user_id = $1`, [user.id]);
    console.log(`Password updated for ${email}. Sign in with the new password.`);
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
