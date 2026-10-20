# CivicFix


Report civic issues, see them on a map, back your neighbours' reports, and let the
ward office work the queue by priority. React + Tailwind on the front, Node + Express
on the back, PostgreSQL for storage, OpenStreetMap + Leaflet for maps. No Docker.

---

## What you need first

- **Node.js 18 or newer**
- **PostgreSQL 12 or newer**, running locally

Create the database once:

```bash
createdb civicpulse
# or:  psql -U postgres -c "CREATE DATABASE civicpulse;"
```

---

## 1. Backend

```bash
cd server
npm install
cp .env.example .env      # then open .env and set DATABASE_URL + JWT_SECRET
npm run setup             # creates tables, indexes, triggers and the admin account
npm run dev               # http://localhost:4000
```

Want sample data to click through? Set `DEMO_LAT` / `DEMO_LNG` in `.env` to your own
coordinates and run `npm run setup:demo` instead. Sample residents sign in with `demo123`.

Admin account comes from `.env` — by default `admin@city.gov` / `admin123`.

## 2. Frontend

In a second terminal:

```bash
cd client
npm install
npm run dev               # http://localhost:5173
```

Vite proxies `/api` and `/uploads` to port 4000, so nothing else to configure.

**Open `http://localhost:5173`, not the LAN IP.** Browsers only hand out GPS on
`https://` or `localhost`, and the app asks for your position the moment it loads.

---

## How the pieces work

**Automatic location.** `useGeo()` calls `navigator.geolocation.watchPosition` when the
app mounts. That position centres the map, drops the "you are here" dot, and pre-fills
the pin on the report form. Drag the pin if the exact spot differs.

**Duplicate detection.** Runs in SQL, not in the browser. When you file a report the
server takes a bounding box of ±50 m, uses the `(category, latitude, longitude)` index to
narrow the scan, then applies the `distance_m()` great-circle function for the exact
check against open reports in the same category. Matches come back as HTTP 409 with the
list attached, which is what raises the *Support existing issue / Create new report*
dialog. The check runs server-side on every insert, so the API is safe on its own.

**Priority score.** A generated column in Postgres:

```sql
priority_score integer GENERATED ALWAYS AS (severity * 10 + upvotes) STORED
```

You can't get it out of step with the data, and the admin table sorts on it by default.

**Upvotes.** `issue_upvotes` has a composite primary key `(issue_id, user_id)`, so one
person can back an issue exactly once. A trigger keeps `issues.upvotes` in step, which
in turn updates the generated priority score.

**Status history.** Another trigger writes to `status_history` on insert and on every
status change, which is what the timeline in the issue detail reads.

---

## API

| Method | Path | Who | Does |
|---|---|---|---|
| POST | `/api/auth/register` | anyone | Create an account, returns a JWT |
| POST | `/api/auth/login` | anyone | Sign in, returns a JWT |
| GET | `/api/auth/me` | signed in | Profile plus contribution counts |
| PATCH | `/api/auth/me` | signed in | Change display name |
| GET | `/api/issues` | signed in | All issues; `?category=&status=&sort=` |
| GET | `/api/issues/mine` | signed in | Filed by, or backed by, you |
| GET | `/api/issues/:id` | signed in | One issue with its status history |
| POST | `/api/issues/check-duplicate` | signed in | Open reports within 50 m, same category |
| POST | `/api/issues` | signed in | File a report (multipart, `photo` field). 409 if duplicates and `confirm` is not set |
| POST | `/api/issues/:id/upvote` | signed in | Support an issue |
| DELETE | `/api/issues/:id/upvote` | signed in | Withdraw support |
| PATCH | `/api/issues/:id/status` | admin | pending → in_progress → resolved |
| GET | `/api/issues/admin/stats` | admin | Dashboard counters |

---

## Layout

```
server/
  src/
    schema.sql          tables, indexes, distance_m(), triggers
    setup.js            npm run setup / setup:demo
    db.js               pg pool
    index.js            express app
    middleware/auth.js  JWT sign + requireAuth + requireAdmin
    routes/auth.js      register, login, profile
    routes/issues.js    reports, duplicate check, upvotes, status, stats
  uploads/              photos land here, served at /uploads
client/
  src/
    App.jsx             shell, tabs, geolocation, issue fetching
    lib/                api client, auth context, useGeo, constants
    components/         Leaflet wrapper, issue detail, shared bits
    pages/              Auth, Map, Report, Mine, Admin, Profile
```

## Notes before this goes anywhere real

- Photos are written to the local disk. On a hosted box use S3 or similar.
- JWTs sit in `localStorage`. Fine for a project, swap for httpOnly cookies in production.
- Add rate limiting on `/api/auth/*` before exposing it publicly.
