import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { q } from '../db.js';
import { sign, requireAuth, requireAdmin } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { wrap, asText, asEmail, asLatitude, asLongitude, badRequest, notFound } from '../lib/validate.js';
import { OAuth2Client } from 'google-auth-library';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@city.gov').toLowerCase();

const r = Router();
const shape = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role, created_at: u.created_at,
  avatar_url: u.avatar_url || null,
  auth_provider: u.auth_provider || 'password',
  office: u.office_lat != null && u.office_lng != null
    ? { latitude: u.office_lat, longitude: u.office_lng, label: u.office_label || 'Ward office' }
    : null
});

r.post('/register', authLimiter, wrap(async (req, res) => {
  const name = asText(req.body.name, 'Name', { min: 2, max: 80 });
  const email = asEmail(req.body.email);
  const password = asText(req.body.password, 'Password', { min: 6, max: 200, trim: false });

  const exists = await q('SELECT 1 FROM users WHERE email = $1', [email]);
  if (exists.rowCount) return res.status(409).json({ error: 'That email is already registered. Sign in instead.' });

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await q(
    'INSERT INTO users (name, email, password_hash) VALUES ($1,$2,$3) RETURNING *',
    [name, email, hash]
  );
  res.status(201).json({ token: sign(rows[0]), user: shape(rows[0]) });
}));

r.post('/login', authLimiter, wrap(async (req, res) => {
  const email = asEmail(req.body.email);
  const { rows } = await q('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (user && !user.password_hash) {
    return res.status(401).json({ error: 'This account signs in with Google. Use the Google button instead.' });
  }
  const ok = user && (await bcrypt.compare(req.body.password || '', user.password_hash));
  if (!ok) return res.status(401).json({ error: 'Email or password is wrong.' });
  res.json({ token: sign(user), user: shape(user) });
}));

r.get('/me', requireAuth, wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!rows[0]) throw notFound('Account not found.');
  const stats = await q(
    `SELECT
       (SELECT count(*) FROM issues WHERE user_id = $1)                         AS reported,
       (SELECT count(*) FROM issues WHERE user_id = $1 AND status = 'resolved') AS resolved,
       (SELECT count(*) FROM issue_upvotes WHERE user_id = $1)                  AS backed,
       (SELECT coalesce(sum(upvotes),0) FROM issues WHERE user_id = $1)         AS support_received`,
    [req.user.id]
  );
  res.json({ user: shape(rows[0]), stats: stats.rows[0] });
}));

r.patch('/me', requireAuth, wrap(async (req, res) => {
  const name = asText(req.body.name, 'Name', { min: 2, max: 80 });
  const { rows } = await q('UPDATE users SET name = $1 WHERE id = $2 RETURNING *', [name, req.user.id]);
  res.json({ user: shape(rows[0]) });
}));

/* Google sign-in.
   The browser sends the ID token Google issued it; we verify that token against
   Google's keys rather than trusting anything the page tells us. A Google account
   always maps to a resident — the ward office signs in with a password, so an
   administrator can never be created by anyone who happens to own an address. */
r.post('/google', authLimiter, wrap(async (req, res) => {
  if (!googleClient) {
    return res.status(503).json({ error: 'Google sign-in is not configured on this server.' });
  }
  const credential = asText(req.body.credential, 'Google credential', { min: 20, max: 4000 });

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    return res.status(401).json({ error: 'That Google sign-in could not be verified.' });
  }

  const email = (payload.email || '').toLowerCase();
  if (!email || payload.email_verified === false) {
    return res.status(401).json({ error: 'Google did not confirm that email address.' });
  }
  if (email === ADMIN_EMAIL) {
    return res.status(403).json({ error: 'The ward office account signs in with its password, not Google.' });
  }

  const existing = await q('SELECT * FROM users WHERE google_sub = $1 OR email = $2', [payload.sub, email]);
  let user = existing.rows[0];

  if (user) {
    const updated = await q(
      `UPDATE users SET google_sub = $1, avatar_url = COALESCE($2, avatar_url),
                        auth_provider = CASE WHEN password_hash IS NULL THEN 'google' ELSE auth_provider END
       WHERE id = $3 RETURNING *`,
      [payload.sub, payload.picture || null, user.id]
    );
    user = updated.rows[0];
  } else {
    const created = await q(
      `INSERT INTO users (name, email, google_sub, avatar_url, auth_provider, role)
       VALUES ($1,$2,$3,$4,'google','user') RETURNING *`,
      [payload.name || email.split('@')[0], email, payload.sub, payload.picture || null]
    );
    user = created.rows[0];
  }

  res.json({ token: sign(user), user: shape(user) });
}));

/* where the crew starts from — admin only */
r.patch('/office', requireAuth, requireAdmin, wrap(async (req, res) => {
  const lat = asLatitude(req.body.latitude);
  const lng = asLongitude(req.body.longitude);
  const label = asText(req.body.label || 'Ward office', 'Label', { max: 80 });
  const { rows } = await q(
    'UPDATE users SET office_lat = $1, office_lng = $2, office_label = $3 WHERE id = $4 RETURNING *',
    [lat, lng, label, req.user.id]
  );
  res.json({ user: shape(rows[0]) });
}));

export default r;
