import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { apiLimiter } from './middleware/rateLimit.js';
import authRoutes from './routes/auth.js';
import issueRoutes from './routes/issues.js';

if (!process.env.DATABASE_URL || !process.env.JWT_SECRET) {
  console.error('Missing DATABASE_URL or JWT_SECRET. Copy .env.example to .env first.');
  process.exit(1);
}

const app = express();
const dir = path.dirname(fileURLToPath(import.meta.url));

/* In development the client is proxied through Vite and shares the origin, so CORS never
   comes up. Once deployed the client is on a different domain and has to be named — an
   open policy would let any site on the internet call this API with a user's token. */
const allowedOrigins = (process.env.CLIENT_ORIGIN || '')
  .split(',').map((o) => o.trim()).filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length
    ? (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin))
    : true,
  credentials: false
}));
app.use(express.json({ limit: '1mb' }));       // reports upload as multipart, not JSON
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
/* Only meaningful when files are on this machine. With Cloudinary configured the
   database holds absolute URLs and nothing is served from here. */
app.use('/uploads', express.static(path.join(dir, 'uploads')));

// behind a reverse proxy (nginx, Render, Railway) this makes req.ip the real client
app.set('trust proxy', 1);
app.use('/api', apiLimiter);

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/issues', issueRoutes);

/* An unknown path under /api should answer in JSON, not with Express's HTML page —
   the client parses every response as JSON and would choke on markup. */
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No endpoint at ${req.method} ${req.originalUrl}.` });
});

/* One place where every failure becomes a response the client can show a person. */
app.use((err, _req, res, _next) => {
  // thrown deliberately by the validators
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message, ...err.extra });
  }

  // multer
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'That file is too large. The limit is 40 MB.' });
  }
  if (err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: `Unexpected file field "${err.field}".` });
  }
  if (err.message === 'Upload a photo or a video.') {
    return res.status(415).json({ error: err.message });
  }

  // postgres, translated into something a person can act on
  switch (err.code) {
    case '23505': return res.status(409).json({ error: 'That already exists.' });
    case '23503': return res.status(409).json({ error: 'That refers to something which no longer exists.' });
    case '23514': return res.status(422).json({ error: 'One of those values is not allowed.' });
    case '22P02': return res.status(400).json({ error: 'One of those values was the wrong type.' });
    case '23502': return res.status(422).json({ error: 'A required field was missing.' });
    case 'ECONNREFUSED':
    case '57P01':
      console.error('Database unreachable:', err.message);
      return res.status(503).json({ error: 'The database is unavailable. Try again in a moment.' });
    default: break;
  }

  // anything left is genuinely ours, and the detail stays in the log
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

/* A rejected promise outside a request used to take the process down mid-response,
   which the browser saw as a dropped connection with no explanation. Log and carry on. */
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

/* Hosts assign the port; they do not ask. */
const port = process.env.PORT || 4000;
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`CivicFix API listening on ${port}`);
  console.log(`  storage : ${process.env.CLOUDINARY_URL ? 'Cloudinary' : 'local disk'}`);
  console.log(`  origins : ${allowedOrigins.length ? allowedOrigins.join(', ') : 'any (development)'}`);
});

/* Finish in-flight requests before exiting, so nothing is half-written. */
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\nShutting down…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
