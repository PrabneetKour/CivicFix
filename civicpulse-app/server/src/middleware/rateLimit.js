import rateLimit from 'express-rate-limit';

const base = { standardHeaders: true, legacyHeaders: false };

/** Blunt ceiling on the whole API so one client can't flood it. */
export const apiLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  max: 300,
  message: { error: 'Too many requests. Slow down for a minute.' }
});

/** Login and register: the endpoints worth brute-forcing. Keyed by IP. */
export const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,   // only failed attempts count toward the limit
  message: { error: 'Too many sign-in attempts. Try again in 15 minutes.' }
});

/** Filing reports: keyed by account, so sharing an IP doesn't punish a whole office. */
export const reportLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => (req.user ? `user:${req.user.id}` : req.ip),
  message: { error: "That's a lot of reports in an hour. Try again later." }
});

/** Upvotes are cheap but spammable. */
export const voteLimiter = rateLimit({
  ...base,
  windowMs: 10 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => (req.user ? `user:${req.user.id}` : req.ip),
  message: { error: 'Too many votes at once. Give it a minute.' }
});
