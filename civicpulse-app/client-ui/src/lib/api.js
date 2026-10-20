/**
 * Talks to the CivicFix Express API.
 *
 * Every function here keeps the name and return shape the UI already expects,
 * so App.jsx did not have to be rewritten — only the bodies changed from mock
 * data to real requests. Vite proxies /api and /uploads to localhost:4000.
 */

/* Empty in development: Vite proxies /api to the server, so a relative path works and
   there is no origin to configure. In a deployed build the API is on its own domain and
   VITE_API_URL names it. */
const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

const TOKEN_KEY = 'civicfix.token';

/** Photos are absolute Cloudinary URLs when hosted, and /uploads paths when local. */
export function assetUrl(url) {
  if (!url) return '';
  if (/^https?:\/\//.test(url)) return url;
  return `${API_BASE}${url}`;
}

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));
export const isAuthed = () => Boolean(getToken());
export const signOut = () => setToken(null);

/* Everything the app knows about talking to the server. Errors are turned into
   sentences a person can act on here, so no screen has to interpret a status code. */
async function request(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const offline = new Error('You appear to be offline. Check your connection and try again.');
    offline.status = 0;
    throw offline;
  }

  let res;
  try {
    res = await fetch(`${API_BASE}/api${path}`, {
      method,
      headers,
      body: form ? form : body ? JSON.stringify(body) : undefined
    });
  } catch {
    // the request never reached the server: no network, or the API is not running
    const down = new Error('Could not reach the server. Is the API running on port 4000?');
    down.status = 0;
    throw down;
  }

  // a proxy or crash can return HTML where JSON was expected
  const raw = await res.text();
  let data = {};
  if (raw) {
    try { data = JSON.parse(raw); }
    catch {
      if (!res.ok) {
        const broken = new Error(`The server returned an unexpected response (${res.status}).`);
        broken.status = res.status;
        throw broken;
      }
    }
  }

  if (!res.ok) {
    const err = new Error(data.error || defaultMessage(res.status));
    err.status = res.status;
    err.data = data;
    if (res.status === 401) {
      setToken(null);
      // let the shell notice and send the person back to sign in
      window.dispatchEvent(new CustomEvent('civicfix:signed-out'));
    }
    throw err;
  }
  return data;
}

function defaultMessage(status) {
  switch (status) {
    case 400: return 'Something in that request was not valid.';
    case 401: return 'Your session has expired. Sign in again.';
    case 403: return 'You do not have permission to do that.';
    case 404: return 'That could not be found.';
    case 409: return 'That conflicts with something already recorded.';
    case 413: return 'That file is too large.';
    case 415: return 'That file type is not accepted.';
    case 422: return 'That report did not meet the evidence rules.';
    case 429: return 'Too many requests in a short time. Wait a minute and try again.';
    case 503: return 'The service is temporarily unavailable. Try again shortly.';
    default:  return status >= 500 ? 'Something went wrong on the server.' : `Request failed (${status}).`;
  }
}

/* ------------------------------------------------------------------ issues */

export async function getIssues(filters = {}) {
  const params = new URLSearchParams();
  if (filters.category && filters.category !== 'all') params.set('category', filters.category);
  if (filters.status && filters.status !== 'all') params.set('status', filters.status);
  const issues = await request(`/issues${params.toString() ? `?${params}` : ''}`);

  if (!filters.search) return issues;
  const query = filters.search.toLowerCase();
  return issues.filter((item) =>
    `${item.description} ${item.category} ${item.reporter} ${item.id}`.toLowerCase().includes(query)
  );
}

/** Ask whether a coordinate is public space before uploading anything. */
export async function checkLand(latitude, longitude) {
  return request('/issues/check-land', { method: 'POST', body: { latitude, longitude } });
}

/** What the server will actually enforce, so the form can match it. */
export async function getPolicy() {
  return request('/issues/policy');
}

export async function getIssue(id) {
  return request(`/issues/${id}`);
}

/**
 * The form hands us a base64 data URL for the photo; the API wants a real file
 * under a multipart field, so convert it here rather than in the component.
 */
export async function createIssue(input) {
  const form = new FormData();
  form.append('category', input.category);
  form.append('description', input.description);
  form.append('severity', String(input.severity));
  form.append('latitude', String(input.latitude));
  form.append('longitude', String(input.longitude));
  form.append('confirm', 'true');            // the UI already ran its own nearby check
  if (input.pinned_by_hand) form.append('pinned_by_hand', 'true');
  if (input.accept_private) form.append('accept_private', 'true');
  if (input.device_lat != null) form.append('device_lat', String(input.device_lat));
  if (input.device_lng != null) form.append('device_lng', String(input.device_lng));

  /* The original files go up untouched — re-encoding a photo would strip the very
     EXIF GPS tag the server checks. */
  if (input.photo_file) form.append('photo', input.photo_file, input.photo_file.name || 'photo.jpg');
  if (input.video_file) form.append('video', input.video_file, input.video_file.name || 'clip.mp4');

  return request('/issues', { method: 'POST', form });
}

/** Confirm or dispute that the issue is really there. One verdict per person. */
export async function verifyIssue(id, verdict) {
  return request(`/issues/${id}/verify`, { method: 'POST', body: { verdict } });
}

export async function withdrawVerification(id) {
  return request(`/issues/${id}/verify`, { method: 'DELETE' });
}

export async function upvoteIssue(id) {
  return request(`/issues/${id}/upvote`, { method: 'POST' });
}

export async function backIssue(id) {
  return upvoteIssue(id);
}

export async function updateIssueStatus(id, status) {
  return request(`/issues/${id}/status`, { method: 'PATCH', body: { status } });
}

export async function getMyReports() {
  const [me, mine] = await Promise.all([request('/auth/me'), request('/issues/mine')]);
  return mine.filter((issue) => issue.user_id === me.user.id);
}

/* -------------------------------------------------------------------- auth */

export async function getCurrentUser() {
  const { user, stats } = await request('/auth/me');
  return {
    ...user,
    stats,
    ward: user.role === 'admin' ? 'Ward office · administrator' : 'Resident register'
  };
}

export async function signIn({ email, password }) {
  const { token, user } = await request('/auth/login', { method: 'POST', body: { email, password } });
  setToken(token);
  return user;
}

/** Hands Google's ID token to our server, which verifies it against Google's keys. */
export async function signInWithGoogle(credential) {
  const { token, user } = await request('/auth/google', { method: 'POST', body: { credential } });
  setToken(token);
  return user;
}

export async function register({ name, email, password }) {
  const { token, user } = await request('/auth/register', { method: 'POST', body: { name, email, password } });
  setToken(token);
  return user;
}

/* --------------------------------------------------------- duplicate check */

export function distanceInMeters(first, second) {
  const R = 6371000;
  const lat1 = (first.latitude * Math.PI) / 180;
  const lat2 = (second.latitude * Math.PI) / 180;
  const dLat = ((second.latitude - first.latitude) * Math.PI) / 180;
  const dLon = ((second.longitude - first.longitude) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Runs in SQL on the server: same category, not resolved, inside the radius.
 * Falls back to a client-side sweep only if no category has been picked yet.
 */
export async function findNearbyIssues(latitude, longitude, radiusMeters = 50, category) {
  if (category) {
    const { duplicates } = await request('/issues/check-duplicate', {
      method: 'POST',
      body: { category, latitude, longitude }
    });
    return duplicates;
  }
  const issues = await getIssues();
  return issues.filter(
    (item) => item.status !== 'resolved' && distanceInMeters({ latitude, longitude }, item) <= radiusMeters
  );
}

/** How much of today's report allowance is left, and when the oldest report ages out. */
export async function getReportQuota() {
  return request('/issues/quota');
}

/* stats for the ward dashboard */
export async function getStats() {
  return request('/issues/admin/stats');
}
