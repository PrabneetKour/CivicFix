import pg from 'pg';
import 'dotenv/config';

/* Managed Postgres (Render, Railway, Neon) requires TLS and presents a certificate this
   process has no root for, so verification is turned off while encryption stays on. A
   local database needs neither. */
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => console.error('Unexpected PG error', err));

export const q = (text, params) => pool.query(text, params);
