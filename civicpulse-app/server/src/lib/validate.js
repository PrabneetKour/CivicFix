/**
 * Input validation and error plumbing.
 *
 * Two problems this solves. First, Express 4 does not catch a rejected promise inside
 * an async route handler — it becomes an unhandled rejection and takes the process down,
 * which is why a single bad id could kill the server. `wrap` funnels those into the
 * normal error handler. Second, ad-hoc `if (!x) return res.status(400)` lines drift
 * apart over time; these helpers keep every message in the same voice.
 */

export class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const badRequest = (message, extra) => new ApiError(400, message, extra);
export const notFound = (message = 'That no longer exists.') => new ApiError(404, message);
export const unprocessable = (message, extra) => new ApiError(422, message, extra);

/** Wraps an async handler so a thrown error reaches the error middleware. */
export const wrap = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

/* ---------------------------------------------------------------- values */

export function asId(value, field = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 2147483647) {
    throw badRequest(`${field} must be a positive whole number.`);
  }
  return n;
}

export function asText(value, field, { min = 1, max = 2000, trim = true } = {}) {
  if (typeof value !== 'string') throw badRequest(`${field} is required.`);
  const text = trim ? value.trim() : value;
  if (text.length < min) {
    throw badRequest(min === 1 ? `${field} cannot be empty.` : `${field} needs at least ${min} characters.`);
  }
  if (text.length > max) throw badRequest(`${field} cannot be longer than ${max} characters.`);
  return text;
}

export function asEmail(value) {
  const email = asText(value, 'Email', { max: 254 }).toLowerCase();
  // deliberately loose: the only real test of an address is sending to it
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw badRequest('That does not look like an email address.');
  return email;
}

export function asEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw badRequest(`${field} must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

export function asInt(value, field, { min, max, fallback } = {}) {
  if ((value === undefined || value === '') && fallback !== undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number.`);
  const rounded = Math.round(n);
  if (min !== undefined && rounded < min) throw badRequest(`${field} cannot be below ${min}.`);
  if (max !== undefined && rounded > max) throw badRequest(`${field} cannot be above ${max}.`);
  return rounded;
}

export function asLatitude(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest('A latitude is required.');
  if (n < -90 || n > 90) throw badRequest('Latitude must be between -90 and 90.');
  if (n === 0) throw badRequest('That latitude looks wrong. Place the pin on the map.');
  return n;
}

export function asLongitude(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest('A longitude is required.');
  if (n < -180 || n > 180) throw badRequest('Longitude must be between -180 and 180.');
  if (n === 0) throw badRequest('That longitude looks wrong. Place the pin on the map.');
  return n;
}
