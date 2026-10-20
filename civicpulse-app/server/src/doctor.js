/**
 * Checks the things that actually break, in the order they break.
 *
 *   npm run doctor
 */
import 'dotenv/config';
import { q, pool } from './db.js';

const ok = (m) => console.log('  OK    ', m);
const bad = (m, fix) => { console.log('  FAIL  ', m); if (fix) console.log('         →', fix); };

console.log('\nCivicFix doctor\n');

// 1. environment
console.log('Environment');
if (process.env.DATABASE_URL) ok('DATABASE_URL is set');
else bad('DATABASE_URL is missing', 'copy .env.example to .env and fill it in');
if (process.env.JWT_SECRET) ok('JWT_SECRET is set');
else bad('JWT_SECRET is missing', 'add any long random string to .env');
console.log('  INFO   REQUIRE_GEOTAG =', process.env.REQUIRE_GEOTAG ?? 'true (default)');
console.log('  INFO   REQUIRE_VIDEO  =', process.env.REQUIRE_VIDEO ?? 'true (default)');
console.log('  INFO   GOOGLE_CLIENT_ID =', process.env.GOOGLE_CLIENT_ID ? 'set' : 'not set (button hidden)');

// 2. database
console.log('\nDatabase');
try {
  await q('SELECT 1');
  ok('connected');
} catch (e) {
  bad(`cannot connect — ${e.message}`, 'is PostgreSQL running, and is the password in DATABASE_URL right?');
  await pool.end().catch(() => {});
  process.exit(1);
}

const tables = ['users', 'issues', 'issue_upvotes', 'status_history', 'issue_verifications'];
for (const t of tables) {
  const { rows } = await q(
    'SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS there', [t]
  );
  rows[0].there ? ok(`table ${t}`) : bad(`table ${t} is missing`, 'run: npm run setup');
}

const columns = ['google_sub', 'office_lat'];
for (const c of columns) {
  const { rows } = await q(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_name = 'users' AND column_name = $1) AS there`, [c]
  );
  rows[0].there ? ok(`users.${c}`) : bad(`users.${c} is missing`, 'run: npm run setup');
}

const issueCols = ['land_class', 'photo_taken_at', 'private_ack', 'video_url'];
for (const c of issueCols) {
  const { rows } = await q(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_name = 'issues' AND column_name = $1) AS there`, [c]
  );
  rows[0].there ? ok(`issues.${c}`) : bad(`issues.${c} is missing`, 'run: npm run setup');
}

// 3. accounts and data
console.log('\nData');
const admins = await q("SELECT count(*)::int AS n FROM users WHERE role = 'admin'");
admins.rows[0].n > 0 ? ok(`${admins.rows[0].n} admin account(s)`) : bad('no admin account', 'run: npm run setup');
const users = await q('SELECT count(*)::int AS n FROM users');
const issues = await q('SELECT count(*)::int AS n FROM issues');
console.log(`  INFO   ${users.rows[0].n} users, ${issues.rows[0].n} issues`);

console.log('\nIf everything above is OK, start the server with: npm run dev');
console.log('Then check http://localhost:4000/api/health in a browser.\n');
await pool.end();
