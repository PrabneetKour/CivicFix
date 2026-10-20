import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { q } from '../db.js';
import exifr from 'exifr';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { reportLimiter, voteLimiter } from '../middleware/rateLimit.js';
import { classifyLand } from '../lib/gis.js';
import { storeUpload } from '../lib/storage.js';
import { wrap, asId, asText, asEnum, asInt, asLatitude, asLongitude, badRequest, notFound, unprocessable } from '../lib/validate.js';

const r = Router();
const DUPE_RADIUS_M = 50;
const REQUIRE_GEOTAG = process.env.REQUIRE_GEOTAG !== 'false';
const REQUIRE_VIDEO  = process.env.REQUIRE_VIDEO  !== 'false';
const REQUIRE_PUBLIC_LAND = process.env.REQUIRE_PUBLIC_LAND !== 'false';
/* Drift is deliberately generous. Someone photographs a pothole on the way to work and
   files it that evening from home — honest behaviour that a tight radius would refuse.
   What we still catch is a photo from another town, or one lifted off the internet. */
const MAX_EXIF_DRIFT_M = Number(process.env.MAX_EXIF_DRIFT_M || 2000);

/* Freshness does the work the radius gave up. A picture of a pothole that was filled
   last year is useless to the ward office however close to it you are standing. */
const MAX_PHOTO_AGE_HOURS = Number(process.env.MAX_PHOTO_AGE_HOURS || 24);
/* A person can file this many reports in any rolling 24 hours. Counted in the
   database rather than in memory, so it survives a restart and cannot be reset by
   reconnecting from a different IP. */
const DAILY_REPORT_QUOTA = Number(process.env.DAILY_REPORT_QUOTA || 5);

const CATEGORIES = ['pothole', 'garbage', 'water_leakage', 'broken_streetlight', 'road_damage'];
const STATUSES = ['pending', 'in_progress', 'resolved'];

/* ---------- evidence upload ----------
   Memory storage rather than disk. storeUpload decides where the bytes actually end up:
   Cloudinary when CLOUDINARY_URL is set, the local disk otherwise. A hosted filesystem is
   wiped on every restart, so photos written there would not survive the first sleep.
   exifr reads a Buffer directly, so nothing has to touch the disk to be inspected. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },   // videos need the headroom
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/');
    if (!ok) return cb(new Error('Upload a photo or a video.'));
    cb(null, true);
  }
});

/* How much of the daily allowance this person has left, and when the oldest
   report in the window ages out. A rolling window, not a midnight reset: filing
   five at 11pm does not hand you five more an hour later. */
async function reportQuota(userId) {
  const { rows } = await q(
    `SELECT count(*)::int AS used, min(created_at) AS oldest
       FROM issues
      WHERE user_id = $1 AND created_at > now() - interval '24 hours'`,
    [userId]
  );
  const used = rows[0].used;
  const oldest = rows[0].oldest;
  return {
    limit: DAILY_REPORT_QUOTA,
    used,
    remaining: Math.max(0, DAILY_REPORT_QUOTA - used),
    resets_at: oldest ? new Date(new Date(oldest).getTime() + 24 * 3600 * 1000).toISOString() : null
  };
}

/* Multer writes to disk before the handler runs, so a report we go on to refuse
   would leave its photo and clip behind for good. Anything that leaves with an
   error takes its uploads with it. */
function discardUploads(files) {
  for (const file of files) {
    if (file?.path) fs.promises.unlink(file.path).catch(() => {});
  }
}

/* one place that decides what an issue looks like over the wire */
const SELECT = `
  SELECT i.*, u.name AS reporter,
         EXISTS (SELECT 1 FROM issue_upvotes v WHERE v.issue_id = i.id AND v.user_id = $1) AS backed_by_me,
         (SELECT ver.verdict FROM issue_verifications ver
            WHERE ver.issue_id = i.id AND ver.user_id = $1) AS my_verdict
  FROM issues i JOIN users u ON u.id = i.user_id`;

/* ---------- duplicate detection ----------
   same category + within 50 m + not already resolved.
   A bounding box narrows the scan with the (category, latitude, longitude)
   index, then distance_m() does the exact great-circle check.            */
async function findNearby(userId, category, lat, lng) {
  const dLat = DUPE_RADIUS_M / 111320;
  const dLng = DUPE_RADIUS_M / (111320 * Math.cos((lat * Math.PI) / 180) || 1);
  const { rows } = await q(
    `${SELECT}
     WHERE i.category = $2
       AND i.status <> 'resolved'
       AND i.latitude  BETWEEN $3 AND $4
       AND i.longitude BETWEEN $5 AND $6
       AND distance_m($7, $8, i.latitude, i.longitude) <= $9
     ORDER BY distance_m($7, $8, i.latitude, i.longitude) ASC
     LIMIT 5`,
    [userId, category, lat - dLat, lat + dLat, lng - dLng, lng + dLng, lat, lng, DUPE_RADIUS_M]
  );
  return rows.map((row) => ({
    ...row,
    distance_m: Math.round(haversine(lat, lng, row.latitude, row.longitude))
  }));
}
function haversine(a1, o1, a2, o2) {
  const R = 6371000, t = (x) => (x * Math.PI) / 180;
  const h = Math.sin(t(a2 - a1) / 2) ** 2 + Math.cos(t(a1)) * Math.cos(t(a2)) * Math.sin(t(o2 - o1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

r.use(requireAuth);

/* everything on the map, with the filters the spec asks for */
r.get('/', wrap(async (req, res) => {
  const { category, status, sort } = req.query;
  const where = [], params = [req.user.id];
  if (category && CATEGORIES.includes(category)) { params.push(category); where.push(`i.category = $${params.length}`); }
  if (status && STATUSES.includes(status)) { params.push(status); where.push(`i.status = $${params.length}`); }
  const order = sort === 'newest' ? 'i.created_at DESC'
    : sort === 'upvotes' ? 'i.upvotes DESC, i.created_at DESC'
    : 'i.priority_score DESC, i.created_at DESC';
  const { rows } = await q(
    `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order}`,
    params
  );
  res.json(rows);
}));

/* The browser has to gate its own submit button, and it cannot guess what the server
   will accept. Rather than duplicating the rules in two places and letting them drift,
   the client asks. */
r.get('/policy', (req, res) => {
  res.json({
    require_geotag: REQUIRE_GEOTAG,
    require_video: REQUIRE_VIDEO,
    require_public_land: REQUIRE_PUBLIC_LAND,
    max_photo_age_hours: MAX_PHOTO_AGE_HOURS,
    max_exif_drift_m: MAX_EXIF_DRIFT_M,
    dupe_radius_m: DUPE_RADIUS_M,
    daily_report_quota: DAILY_REPORT_QUOTA
  });
});

/* What the person filing has left today, so the form can say so before they start. */
r.get('/quota', wrap(async (req, res) => {
  res.json(await reportQuota(req.user.id));
}));

r.get('/mine', wrap(async (req, res) => {
  const { rows } = await q(
    `${SELECT} WHERE i.user_id = $1
        OR i.id IN (SELECT issue_id FROM issue_upvotes WHERE user_id = $1)
      ORDER BY i.created_at DESC`,
    [req.user.id]
  );
  res.json(rows);
}));

/* called by the report form before it submits */
r.post('/check-duplicate', wrap(async (req, res) => {
  const category = asEnum(req.body.category, CATEGORIES, 'Category');
  const lat = asLatitude(req.body.latitude);
  const lng = asLongitude(req.body.longitude);
  res.json({ radius_m: DUPE_RADIUS_M, duplicates: await findNearby(req.user.id, category, lat, lng) });
}));

/* the report form calls this once the pin settles, so the resident learns about a
   private-property problem before uploading a video over venue wifi */
r.post('/check-land', wrap(async (req, res) => {
  const lat = asLatitude(req.body.latitude);
  const lng = asLongitude(req.body.longitude);
  res.json({ ...(await classifyLand(lat, lng)), enforced: REQUIRE_PUBLIC_LAND });
}));

r.get('/:id', wrap(async (req, res) => {
  const id = asId(req.params.id);
  const { rows } = await q(`${SELECT} WHERE i.id = $2`, [req.user.id, id]);
  if (!rows[0]) throw notFound('That report no longer exists.');
  const history = await q('SELECT status, changed_at FROM status_history WHERE issue_id = $1 ORDER BY changed_at', [id]);
  res.json({ ...rows[0], history: history.rows });
}));

/* file a report. The 50 m check runs again here so the API is safe on its own. */
const evidence = upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'video', maxCount: 1 }]);

r.post('/', reportLimiter, evidence, wrap(async (req, res) => {
  const photoFile = req.files?.photo?.[0] || null;
  const videoFile = req.files?.video?.[0] || null;
  const category = asEnum(req.body.category, CATEGORIES, 'Category');
  const description = asText(req.body.description, 'Description', { min: 10, max: 1000 });
  const severity = asInt(req.body.severity, 'Severity', { min: 1, max: 5, fallback: 3 });
  const lat = asLatitude(req.body.latitude);
  const lng = asLongitude(req.body.longitude);
  const confirmed = req.body.confirm === 'true' || req.body.confirm === true;

  /* Any exit that is not a success takes the uploaded files with it. Registered
     here so it covers every rule below, thrown or returned alike. */
  res.on('finish', () => {
    if (res.statusCode >= 400) discardUploads([photoFile, videoFile]);
  });

  /* The daily allowance. Checked before any of the evidence work, so someone who
     has run out is told immediately rather than after an EXIF parse and a GIS call. */
  const quota = await reportQuota(req.user.id);
  if (quota.remaining <= 0) {
    const resets = new Date(quota.resets_at);
    const hours = Math.max(1, Math.ceil((resets.getTime() - Date.now()) / 3600000));
    return res.status(429).json({
      error: `You have filed ${quota.used} reports in the last 24 hours, which is the limit. You can file again in about ${hours} hour${hours === 1 ? '' : 's'}. If something urgent needs attention now, back an existing report instead.`,
      quota
    });
  }

  /* Evidence rules. A report has to carry a geotagged still and a clip, because a
     picture plus a GPS tag plus moving footage is far harder to fabricate than any
     one of them alone. Both rules can be relaxed from .env if devices cannot meet them. */
  if (!photoFile) throw unprocessable('A photo of the issue is required.');
  if (!photoFile.mimetype.startsWith('image/')) throw unprocessable('The photo field must hold an image.');
  if (REQUIRE_VIDEO && !videoFile) throw unprocessable('A short video of the issue is required.');
  if (videoFile && !videoFile.mimetype.startsWith('video/')) throw unprocessable('The video field must hold a video.');

  const media_type = videoFile ? 'video' : 'photo';

  /* A photo may carry its own GPS tag. We never reject a file for lacking one —
     phone cameras in a browser produce none, and messaging apps strip EXIF — but
     when it is present we record it and how far it sits from the submitted pin.
     That difference is a trust signal the ward office can weigh. */
  let exif_lat = null, exif_lng = null, exif_drift_m = null, photo_taken_at = null;
  let geo_source = req.body.pinned_by_hand === 'true' ? 'manual' : 'device';

  /* Two calls on purpose. exifr's `pick` filters the whole result, so asking for
     DateTimeOriginal in the same call as gps silently drops latitude and longitude. */
  try {
    const gps = await exifr.gps(photoFile.buffer);
    if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
      exif_lat = gps.latitude;
      exif_lng = gps.longitude;
      exif_drift_m = Math.round(haversine(lat, lng, exif_lat, exif_lng));
      geo_source = 'exif';
    }
  } catch { /* unreadable or absent EXIF is normal, not an error */ }

  try {
    const times = await exifr.parse(photoFile.buffer, { pick: ['DateTimeOriginal', 'CreateDate'] });
    const shot = times?.DateTimeOriginal || times?.CreateDate;
    if (shot) photo_taken_at = new Date(shot);
  } catch { /* no timestamp is not evidence of anything */ }

  /* Age check. Only applied when the camera recorded a capture time — a missing
     timestamp is not evidence of anything, and refusing it would punish the honest. */
  if (photo_taken_at && !Number.isNaN(photo_taken_at.getTime()) && MAX_PHOTO_AGE_HOURS > 0) {
    const ageHours = (Date.now() - photo_taken_at.getTime()) / 3600000;
    if (ageHours > MAX_PHOTO_AGE_HOURS) {
      const days = Math.floor(ageHours / 24);
      return res.status(422).json({
        error: `This photo was taken ${days >= 1 ? `${days} day${days === 1 ? '' : 's'}` : `${Math.round(ageHours)} hours`} ago. Reports need a recent picture — the ward office cannot act on something that may already have been fixed. Take a fresh photo of the issue.`,
        photo_age_hours: Math.round(ageHours)
      });
    }
    if (ageHours < -2) {
      return res.status(422).json({ error: "This photo's timestamp is in the future, so it cannot be trusted. Check the date and time on the camera." });
    }
  }

  if (REQUIRE_GEOTAG && exif_lat === null) {
    return res.status(422).json({
      error: 'This photo carries no location tag. Take it with your phone camera app with location switched on — photos captured inside a browser, or sent through messaging apps, have the tag stripped.'
    });
  }

  /* Where the camera says it stood beats where the form says the pin is. */
  const finalLat = exif_lat ?? lat;
  const finalLng = exif_lng ?? lng;

  /* The 50 m duplicate sweep, against the coordinate we are actually going to file.
     It has to run after the EXIF pass, because that is what settles the coordinate. */
  if (!confirmed) {
    const duplicates = await findNearby(req.user.id, category, finalLat, finalLng);
    if (duplicates.length) {
      return res.status(409).json({
        error: 'Possible issue already reported nearby',
        radius_m: DUPE_RADIUS_M,
        duplicates
      });
    }
  }

  /* The device's own reading, sent alongside, is a second independent witness.
     If the photo was taken somewhere else entirely, these two disagree — which is
     exactly the shape of a report filed from an old picture or someone else's. */
  const deviceLat = Number(req.body.device_lat);
  const deviceLng = Number(req.body.device_lng);
  const hasDeviceFix = Number.isFinite(deviceLat) && Number.isFinite(deviceLng);

  if (exif_lat !== null && hasDeviceFix) {
    const gap = Math.round(haversine(exif_lat, exif_lng, deviceLat, deviceLng));
    if (gap > MAX_EXIF_DRIFT_M) {
      const away = gap > 1500 ? `${(gap / 1000).toFixed(1)} km` : `${gap} m`;
      return res.status(422).json({
        error: `The issue location is not where this photo was taken — the camera recorded a spot ${away} from where you are now. Filing later from home is fine, but the photo has to be from the same area as the report.`,
        exif_drift_m: gap,
        exif: { latitude: exif_lat, longitude: exif_lng },
        device: { latitude: deviceLat, longitude: deviceLng }
      });
    }
  }

  /* GIS: is this public space at all? Fails open if OpenStreetMap is unreachable.

     A private-land verdict warns rather than forbids. Map data is imperfect — a genuine
     pothole on a lane that OSM has drawn as a housing plot would otherwise be unreportable.
     So the reporter is told plainly and asked whether to continue, and the answer is
     recorded on the report for the ward office to weigh. */
  const land = await classifyLand(finalLat, finalLng);
  const acknowledgedPrivate = req.body.accept_private === 'true' || req.body.accept_private === true;

  if (REQUIRE_PUBLIC_LAND && land.land_class === 'private' && !acknowledgedPrivate) {
    return res.status(422).json({
      error: `This looks like private property. ${land.land_note}`,
      needs_confirmation: 'private_land',
      land_class: land.land_class,
      land_note: land.land_note
    });
  }
  /* Upload last. Every check above can still reject the report, and there is no sense
     paying for storage — or leaving orphans in it — for a report that never existed. */
  const storedPhoto = await storeUpload(photoFile);
  const photo_url = storedPhoto.url;
  const video_url = videoFile ? (await storeUpload(videoFile)).url : null;

  const { rows } = await q(
    `INSERT INTO issues (user_id, photo_url, category, description, severity, latitude, longitude,
                         media_type, geo_source, exif_lat, exif_lng, exif_drift_m, video_url,
                         land_class, land_note, device_lat, device_lng, photo_taken_at, private_ack)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [req.user.id, photo_url, category, description, severity, finalLat, finalLng,
     media_type, geo_source, exif_lat, exif_lng, exif_drift_m, video_url,
     land.land_class, land.land_note, hasDeviceFix ? deviceLat : null, hasDeviceFix ? deviceLng : null,
     photo_taken_at && !Number.isNaN(photo_taken_at.getTime()) ? photo_taken_at : null,
     land.land_class === 'private' && acknowledgedPrivate]
  );
  /* The reporter is not counted as a supporter of their own report. Priority is
     meant to measure how many *other* residents feel the same problem, and a maker
     who also backs and verifies their own entry is the whole thing the separation
     of maker and checker exists to prevent. A new report therefore starts at
     severity x 10, and every point above that came from somebody else. */
  const created = await q(`${SELECT} WHERE i.id = $2`, [req.user.id, rows[0].id]);
  res.status(201).json({ ...created.rows[0], quota: await reportQuota(req.user.id) });
}));

/* community upvotes */
r.post('/:id/upvote', voteLimiter, wrap(async (req, res) => {
  const id = asId(req.params.id);
  const owner = await q('SELECT user_id FROM issues WHERE id = $1', [id]);
  if (!owner.rowCount) throw notFound('That report no longer exists.');
  /* Same separation the verify route enforces: the person who raised a report
     does not get to inflate its priority by backing it. */
  if (owner.rows[0].user_id === req.user.id) {
    return res.status(403).json({ error: 'You cannot back your own report. Its priority comes from other residents.' });
  }
  const ins = await q(
    'INSERT INTO issue_upvotes (issue_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING issue_id',
    [id, req.user.id]
  );
  if (!ins.rowCount) return res.status(409).json({ error: 'You are already backing this issue.' });
  const { rows } = await q(`${SELECT} WHERE i.id = $2`, [req.user.id, id]);
  res.json(rows[0]);
}));

r.delete('/:id/upvote', wrap(async (req, res) => {
  const id = asId(req.params.id);
  await q('DELETE FROM issue_upvotes WHERE issue_id = $1 AND user_id = $2', [id, req.user.id]);
  const { rows } = await q(`${SELECT} WHERE i.id = $2`, [req.user.id, id]);
  res.json(rows[0]);
}));

/* community verification: is this actually there?
   One verdict per person per issue, enforced by the table's primary key. */
r.post('/:id/verify', voteLimiter, wrap(async (req, res) => {
  const verdict = asEnum(req.body.verdict, ['confirm', 'dispute'], 'Verdict');
  const id = asId(req.params.id);
  const owner = await q('SELECT user_id FROM issues WHERE id = $1', [id]);
  if (!owner.rowCount) throw notFound('That report no longer exists.');
  if (owner.rows[0].user_id === req.user.id) {
    return res.status(403).json({ error: 'You cannot verify your own report.' });
  }
  await q(
    `INSERT INTO issue_verifications (issue_id, user_id, verdict) VALUES ($1,$2,$3)
     ON CONFLICT (issue_id, user_id) DO UPDATE SET verdict = EXCLUDED.verdict, created_at = now()`,
    [id, req.user.id, verdict]
  );
  const { rows } = await q(`${SELECT} WHERE i.id = $2`, [req.user.id, id]);
  res.json(rows[0]);
}));

r.delete('/:id/verify', wrap(async (req, res) => {
  const id = asId(req.params.id);
  await q('DELETE FROM issue_verifications WHERE issue_id = $1 AND user_id = $2', [id, req.user.id]);
  const { rows } = await q(`${SELECT} WHERE i.id = $2`, [req.user.id, id]);
  res.json(rows[0]);
}));

/* status tracking — admin only */
r.patch('/:id/status', requireAdmin, wrap(async (req, res) => {
  const id = asId(req.params.id);
  const status = asEnum(req.body.status, STATUSES, 'Status');

  /* The last leg of maker and checker. An administrator who files a report is its
     maker, and cannot then sign off their own work — marking it resolved is the
     strongest claim the system makes, so it has to come from a second person.
     Set ALLOW_SELF_SIGNOFF=true only for a single-account demo. */
  const owner = await q('SELECT user_id FROM issues WHERE id = $1', [id]);
  if (!owner.rowCount) throw notFound('That report no longer exists.');
  if (owner.rows[0].user_id === req.user.id && process.env.ALLOW_SELF_SIGNOFF !== 'true') {
    return res.status(403).json({
      error: 'You filed this report, so another administrator has to update its status.'
    });
  }

  const upd = await q('UPDATE issues SET status = $1 WHERE id = $2 RETURNING id', [status, id]);
  if (!upd.rowCount) throw notFound('That report no longer exists.');
  await q('UPDATE status_history SET changed_by = $1 WHERE id = (SELECT max(id) FROM status_history WHERE issue_id = $2)', [req.user.id, id]);
  const { rows } = await q(`${SELECT} WHERE i.id = $2`, [req.user.id, id]);
  res.json(rows[0]);
}));

r.get('/admin/stats', requireAdmin, wrap(async (_req, res) => {
  const { rows } = await q(
    `SELECT count(*)                                        AS total,
            count(*) FILTER (WHERE status = 'pending')      AS pending,
            count(*) FILTER (WHERE status = 'in_progress')  AS in_progress,
            count(*) FILTER (WHERE status = 'resolved')     AS resolved,
            coalesce(sum(upvotes), 0)                       AS supporters,
            coalesce(max(priority_score), 0)                AS top_priority,
            coalesce(sum(confirmations), 0)                 AS confirmations,
            count(*) FILTER (WHERE disputes > confirmations) AS disputed
     FROM issues`
  );
  res.json(rows[0]);
}));

export default r;
