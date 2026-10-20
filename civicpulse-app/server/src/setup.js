/**
 * Creates the tables, then the admin account from .env.
 * Pass --demo to also insert a handful of sample reports around DEMO_LAT/DEMO_LNG.
 *   npm run setup
 *   npm run setup:demo
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { pool, q } from './db.js';

const dir = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8');
  await q(sql);
  console.log('Tables, indexes and triggers are in place.');

  const email = (process.env.ADMIN_EMAIL || 'admin@city.gov').toLowerCase();
  const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'admin123', 10);
  const { rows } = await q(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'admin')
     ON CONFLICT (email) DO UPDATE SET role = 'admin', password_hash = EXCLUDED.password_hash
     RETURNING id, email`,
    [process.env.ADMIN_NAME || 'Ward Office', email, hash]
  );
  console.log(`Admin ready: ${rows[0].email}`);

  if (process.argv.includes('--demo')) await demo();
  await pool.end();
}

async function demo() {
  const lat = Number(process.env.DEMO_LAT || 19.9975);
  const lng = Number(process.env.DEMO_LNG || 73.7898);
  const pass = await bcrypt.hash('demo123', 10);

  const people = [['Meera Iyer', 'meera@example.com'], ['Arjun Rao', 'arjun@example.com'], ['Sana Qureshi', 'sana@example.com']];
  const ids = [];
  for (const [name, mail] of people) {
    const { rows } = await q(
      `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [name, mail, pass]
    );
    ids.push(rows[0].id);
  }

  const specs = [
    ['pothole', 'Wheel-deep pothole in the left lane outside the school gate. Two-wheelers swerve into oncoming traffic every morning.', 5, 'in_progress', 300],
    ['garbage', 'Bins outside the market have not been cleared in four days. Dogs are pulling waste across the footpath.', 3, 'pending', 850],
    ['water_leakage', 'Mains pipe leaking at the junction since the weekend. Continuous flow, the road is permanently wet.', 4, 'pending', 1300],
    ['broken_streetlight', 'Three lights dark between the bus stop and the temple. The stretch is unlit after 7pm.', 3, 'pending', 600],
    ['road_damage', 'Surface broke up after the drain work was backfilled. Loose gravel across the full width.', 2, 'resolved', 1800]
  ];

  let n = 0;
  for (const [category, description, severity, status, dist] of specs) {
    const angle = Math.random() * Math.PI * 2;
    const dLat = (dist / 111320) * Math.cos(angle);
    const dLng = (dist / (111320 * Math.cos((lat * Math.PI) / 180))) * Math.sin(angle);
    const owner = ids[n % ids.length];
    const { rows } = await q(
      `INSERT INTO issues (user_id, category, description, severity, status, latitude, longitude, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now() - $8::interval) RETURNING id`,
      [owner, category, description, severity, status, +(lat + dLat).toFixed(6), +(lng + dLng).toFixed(6), `${(n + 1) * 9} hours`]
    );
    // give each one a few supporters so the priority scores differ
    for (const voter of ids.slice(0, 1 + (n % 3))) {
      await q('INSERT INTO issue_upvotes (issue_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [rows[0].id, voter]);
    }
    n++;
  }
  console.log(`Inserted ${specs.length} sample reports around ${lat}, ${lng} (residents log in with demo123).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
