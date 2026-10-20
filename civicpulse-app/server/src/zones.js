/**
 * Manage the local land-zone table from the command line.
 *
 *   npm run zones                                    list them
 *   npm run zones -- add "Name" private 12.82 80.04 900 "why"
 *   npm run zones -- remove "Name"
 *   npm run zones -- check 12.8231 80.0442           what would the app say here
 *
 * Adding a zone is the fastest way to correct a wrong verdict: drop a pin in the report
 * form, read the coordinates it shows, and record what is actually there.
 */
import 'dotenv/config';
import { q, pool } from './db.js';

const [, , command = 'list', ...rest] = process.argv;

const list = async () => {
  const { rows } = await q('SELECT name, kind, latitude, longitude, radius_m FROM land_zones ORDER BY kind, name');
  if (!rows.length) return console.log('\nNo zones recorded yet. Run: npm run setup\n');
  console.log('\nKnown land zones\n');
  for (const z of rows) {
    console.log(`  ${z.kind.padEnd(8)} ${z.name}`);
    console.log(`           ${Number(z.latitude).toFixed(5)}, ${Number(z.longitude).toFixed(5)} · ${z.radius_m} m radius`);
  }
  console.log('');
};

const add = async ([name, kind, lat, lng, radius, note]) => {
  if (!name || !['private', 'public'].includes(kind) || !lat || !lng || !radius) {
    return console.log('Usage: npm run zones -- add "Name" private|public <lat> <lng> <radius_m> ["note"]');
  }
  await q(
    `INSERT INTO land_zones (name, kind, latitude, longitude, radius_m, note)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (name) DO UPDATE SET
       kind = EXCLUDED.kind, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
       radius_m = EXCLUDED.radius_m, note = EXCLUDED.note`,
    [name, kind, Number(lat), Number(lng), Math.round(Number(radius)), note || null]
  );
  console.log(`\nSaved: ${name} (${kind}, ${radius} m)\n`);
};

const remove = async ([name]) => {
  const { rowCount } = await q('DELETE FROM land_zones WHERE name = $1', [name]);
  console.log(rowCount ? `\nRemoved ${name}\n` : `\nNo zone called "${name}"\n`);
};

const check = async ([lat, lng]) => {
  const { rows } = await q(
    `SELECT name, kind, radius_m, round(distance_m($1,$2,latitude,longitude)::numeric) AS metres
       FROM land_zones ORDER BY distance_m($1,$2,latitude,longitude) ASC LIMIT 3`,
    [Number(lat), Number(lng)]
  );
  console.log(`\nNearest zones to ${lat}, ${lng}\n`);
  for (const z of rows) {
    const inside = Number(z.metres) <= z.radius_m;
    console.log(`  ${inside ? '→ INSIDE ' : '         '}${z.name} · ${z.metres} m away, radius ${z.radius_m} m (${z.kind})`);
  }
  console.log(rows.some((z) => Number(z.metres) <= z.radius_m)
    ? '\nThis point is settled by the local table.\n'
    : '\nNo local zone covers this point; the app would ask OpenStreetMap.\n');
};

const commands = { list, add, remove, check };
await (commands[command] || list)(rest);
await pool.end();
