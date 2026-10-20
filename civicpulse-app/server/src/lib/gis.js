/**
 * Land-use classification from OpenStreetMap.
 *
 * A civic register is for public space — roads, footpaths, parks, drains. A pothole
 * inside someone's compound is not the ward office's to fix, and a report pinned on a
 * private plot is either a mistake or an attempt to aim municipal attention at a
 * neighbour. This asks OSM what is actually at the coordinate.
 *
 * Two questions go to Overpass in one request:
 *   1. Is the point inside a building or a plot tagged as private?
 *   2. Is there a road, footpath or public feature within 25 m?
 *
 * The service is public and occasionally slow, so every failure path returns
 * 'unknown' rather than blocking a report. A civic tool must not stop working
 * because someone else's server is down.
 */

/* Overpass is often blocked on campus and corporate networks, and its public instances
   rate-limit. Try each in turn, then fall back to Nominatim, which answers a coarser
   question but is reachable far more often. */
import { q } from '../db.js';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];
const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const NEAR_M = 12;   // 25 m reached across a plot and found the next street over
const TIMEOUT_MS = 3500;          // a report must not wait on someone else's server
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();          // coarse coordinate -> verdict, so dragging a pin is cheap

const PUBLIC_HIGHWAY = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
  'residential', 'service', 'living_street', 'pedestrian', 'footway',
  'path', 'cycleway', 'steps', 'track'
]);

const PUBLIC_SPACE = new Set([
  'park', 'garden', 'playground', 'pitch', 'recreation_ground', 'common',
  'village_green', 'cemetery', 'school', 'hospital', 'marketplace'
]);

/**
 * Reverse geocoding as a second opinion. Nominatim will not tell us about building
 * footprints, but it does say whether the nearest mapped thing is a road — which answers
 * the question that actually matters most of the time.
 */
async function coarseCheck(latitude, longitude) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const url = `${NOMINATIM}?format=jsonv2&zoom=18&addressdetails=1&lat=${latitude}&lon=${longitude}`;
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'CivicFix/1.0' } });
    clearTimeout(timer);
    if (!response.ok) throw new Error('nominatim');
    const data = await response.json();

    const category = data?.category || data?.class || '';
    const type = data?.type || '';
    const address = data?.address || {};

    /* Every address contains a street name — that is what an address is. It says nothing
       about whether the point is *on* that street, so it is not evidence of public land.
       Only the feature Nominatim actually matched counts. */
    if (category === 'highway') {
      return { land_class: 'public', land_note: `Nearest mapped feature is a road${data.name ? `: ${data.name}` : ''}.` };
    }
    if (['park', 'garden', 'playground', 'pitch', 'recreation_ground', 'marketplace'].includes(type)) {
      return { land_class: 'public', land_note: 'Public open space at this location.' };
    }

    /* A house number is the strongest cheap signal that this is somebody's plot. */
    if (category === 'building' || address.house_number || ['house', 'residential', 'apartments', 'detached', 'yes'].includes(type)) {
      const where = address.house_number
        ? `${address.house_number}${address.road ? ` ${address.road}` : ''}`
        : (data.name || 'a building');
      return { land_class: 'private', land_note: `The pin resolves to ${where}, which is an address rather than a road.` };
    }
    if (['university', 'school', 'hospital', 'college'].includes(type)) {
      return {
        land_class: 'private',
        land_note: `The pin is inside ${data.name || 'an institutional campus'}. Internal roads there are the institution's responsibility, not the ward office's.`
      };
    }

    return { land_class: 'unknown', land_note: 'Nothing conclusive is mapped at this point.' };
  } catch {
    return { land_class: 'unknown', land_note: 'Land-use services are unreachable from this network, so the location was not checked.' };
  }
}

/**
 * Zones the ward office already knows about — campuses, corporate estates, gated
 * societies. Checked before anything external, because it is a single indexed query
 * against a small table and needs no network at all.
 *
 * A match here is final. Somebody entered it deliberately, which beats whatever a
 * volunteer did or did not map.
 */
async function knownZone(latitude, longitude) {
  try {
    const { rows } = await q(
      `SELECT name, kind, note, radius_m,
              distance_m($1, $2, latitude, longitude) AS metres
         FROM land_zones
        WHERE distance_m($1, $2, latitude, longitude) <= radius_m
        ORDER BY metres ASC
        LIMIT 1`,
      [latitude, longitude]
    );
    if (!rows.length) return null;
    const zone = rows[0];
    return {
      land_class: zone.kind,
      land_note: zone.note || `Inside ${zone.name}, a known ${zone.kind} area.`,
      source: 'local'
    };
  } catch {
    // the table may not exist yet on an older database; fall through to the services
    return null;
  }
}

export async function classifyLand(latitude, longitude) {
  const known = await knownZone(latitude, longitude);
  if (known) return known;

  const query = `
    [out:json][timeout:5];
    (
      is_in(${latitude},${longitude})->.here;
      way(pivot.here)["building"];
      way(pivot.here)["landuse"];
      way(pivot.here)["access"];
      way(around:${NEAR_M},${latitude},${longitude})["highway"];
      way(around:${NEAR_M},${latitude},${longitude})["leisure"];
      way(around:${NEAR_M},${latitude},${longitude})["amenity"];
    );
    out tags;`;

  const key = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let elements = null;
  for (const endpoint of ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      const response = await fetch(endpoint, {
        method: 'POST',
        body: query,
        headers: { 'Content-Type': 'text/plain' },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response.ok) continue;
      elements = (await response.json()).elements || [];
      break;
    } catch {
      // try the next mirror
    }
  }

  if (elements === null) {
    const fallback = await coarseCheck(latitude, longitude);
    cache.set(key, { at: Date.now(), value: fallback });
    return fallback;
  }

  const remember = (value) => { cache.set(key, { at: Date.now(), value }); return value; };
  const tags = elements.map((element) => element.tags || {});

  const building = tags.find((t) => t.building);
  const publicBuilding = building &&
    ['school', 'hospital', 'civic', 'government', 'public', 'train_station', 'toilets'].includes(building.building);
  if (building && !publicBuilding) {
    return {
      land_class: 'private',
      land_note: `The pin sits inside a building${building.name ? ` (${building.name})` : ''}. Civic reports must be about public space.`
    };
  }

  /* Order matters. A service road runs past almost everything, so "a road within range"
     must not outrank land that is explicitly closed, or the inside of a campus. */
  const road = tags.find((t) => t.highway && PUBLIC_HIGHWAY.has(t.highway)
    && !['private', 'no', 'customers', 'permit'].includes(t.access));
  const campus = tags.find((t) => ['university', 'school', 'college', 'hospital'].includes(t.amenity)
    || ['education', 'institutional', 'religious'].includes(t.landuse));
  const openSpace = tags.find((t) => PUBLIC_SPACE.has(t.leisure) || PUBLIC_SPACE.has(t.amenity));
  const closedAccess = tags.find((t) => ['private', 'no'].includes(t.access) && !t.highway);
  const closedLanduse = tags.find((t) =>
    ['residential', 'industrial', 'commercial', 'retail', 'farmyard', 'military'].includes(t.landuse) && !t.highway);

  if (closedAccess) return remember({ land_class: 'private', land_note: 'This land is tagged as private access in OpenStreetMap.' });
  if (campus && !road) {
    return remember({
      land_class: 'private',
      land_note: `The pin is inside ${campus.name || 'an institutional campus'}. Internal roads there are the institution's responsibility.`
    });
  }
  if (road) {
    return {
      land_class: 'public',
      land_note: `Public road within ${NEAR_M} m${road.name ? `: ${road.name}` : ` (${road.highway})`}.`
    };
  }
  if (openSpace) return remember({ land_class: 'public', land_note: 'Public open space at this location.' });
  if (closedLanduse) {
    return {
      land_class: 'private',
      land_note: `The pin sits inside a ${closedLanduse.landuse} plot with no public road nearby.`
    };
  }

  return remember({ land_class: 'unknown', land_note: `No mapped road or public space within ${NEAR_M} m of the pin.` });
}
