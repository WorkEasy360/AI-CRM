/**
 * Session handling and request wrappers.
 *
 * Auth is a Django cookie session + CSRF double-submit:
 *   1. GET  /api/v1/session/                 -> 403 for anonymous, but sets the CSRF cookie
 *   2. POST /_allauth/browser/v1/auth/login  -> 200 (401 = pending MFA / verification: treated as failure)
 *      Django rotates the CSRF cookie on login, so the token is re-read from the jar afterwards.
 *   3. GET  /api/v1/session/                 -> 200 {active: {...} | null}
 *      null -> POST /api/v1/session/bootstrap/ -> 200 {active: {...}}
 *
 * k6 keeps one cookie jar per VU, so each VU behaves like one browser. Login happens once per VU
 * (Argon2 is expensive); the session and the CSRF token live in module-level variables, which are
 * per-VU in k6.
 *
 * Every request goes through apiGet / apiPost / apiPostMultipart, which set `tags.name` to a logical
 * endpoint name so per-endpoint percentiles never carry UUIDs, and feed the custom metrics.
 */
import http from 'k6/http';
import { PASSWORD } from './data.js';
import { expectStatus, loginDuration, recordResponse, safeJson } from './checks.js';

export const BASE = (__ENV.BASE_URL || 'http://host.docker.internal:8000').replace(/\/+$/, '');
export const API = `${BASE}/api/v1`;
export const ALLAUTH = `${BASE}/_allauth/browser/v1`;
export const SESSION_COOKIE = __ENV.SESSION_COOKIE || 'keel_session';
export const CSRF_COOKIE = __ENV.CSRF_COOKIE || 'keel_csrftoken';
export const CSRF_HEADER = 'X-CSRFToken';

/** How long a login counts as "recent" for reauth-guarded actions (server: 10 min). Re-auth a bit early. */
const RECENT_AUTH_MAX_AGE_MS = Number(__ENV.RECENT_AUTH_MINUTES || 8) * 60 * 1000;

// 2xx/3xx are successes; 429 is measured as `throttled`, not as an HTTP failure. Anything else
// (401/403/404/409/5xx ...) counts towards http_req_failed unless a call overrides this.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 429));

/** Expected-status sets for calls whose failure semantics differ from the default. */
export const EXPECT_MOVE = http.expectedStatuses({ min: 200, max: 399 }, 409, 429);
const EXPECT_ANON_SESSION = http.expectedStatuses(200, 403, 429);
const EXPECT_LOGOUT = http.expectedStatuses(200, 401, 429);

// ---------------------------------------------------------------------------------------- per-VU state
let session = null; // { email, active, loginAt, authAt }
let csrfCache = '';

/** Read the CSRF cookie from the jar of this VU (last value wins after rotation). */
export function csrfFromJar() {
  const cookies = http.cookieJar().cookiesForURL(`${BASE}/`);
  const values = cookies[CSRF_COOKIE];
  return values && values.length ? values[values.length - 1] : '';
}

export function refreshCsrf() {
  csrfCache = csrfFromJar();
  return csrfCache;
}

export function currentCsrf() {
  if (!csrfCache) csrfCache = csrfFromJar();
  return csrfCache;
}

export function currentSession() {
  return session;
}

// ---------------------------------------------------------------------------------------- wrappers
function withDefaults(name, params, headers) {
  const p = Object.assign({}, params || {});
  p.headers = Object.assign({}, headers, (params && params.headers) || {});
  p.tags = Object.assign({ name }, (params && params.tags) || {});
  return p;
}

function absolute(path) {
  return /^https?:\/\//.test(path) ? path : `${API}${path}`;
}

/** GET an /api/v1 path (or absolute URL). `name` is the logical endpoint tag. */
export function apiGet(path, name, params) {
  const res = http.get(absolute(path), withDefaults(name, params, { Accept: 'application/json' }));
  recordResponse(name, res);
  return res;
}

/** POST JSON to an /api/v1 path with the CSRF header. */
export function apiPost(path, body, name, params) {
  const res = http.post(
    absolute(path),
    JSON.stringify(body === undefined ? {} : body),
    withDefaults(name, params, {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      [CSRF_HEADER]: currentCsrf(),
    }),
  );
  recordResponse(name, res);
  return res;
}

/** POST multipart form data (k6 builds the boundary itself; do not set Content-Type). */
export function apiPostMultipart(path, fields, name, params) {
  const res = http.post(
    absolute(path),
    fields,
    withDefaults(name, params, { Accept: 'application/json', [CSRF_HEADER]: currentCsrf() }),
  );
  recordResponse(name, res);
  return res;
}

function allauthPost(path, body, name, params) {
  const res = http.post(
    `${ALLAUTH}${path}`,
    JSON.stringify(body),
    withDefaults(name, params, {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      [CSRF_HEADER]: currentCsrf(),
    }),
  );
  recordResponse(name, res);
  return res;
}

// ---------------------------------------------------------------------------------------- login flow
/** Full login handshake for `user`. Throws when the VU cannot obtain an authenticated tenant session. */
export function login(user) {
  const started = Date.now();
  const email = user.email;

  // 1) Seed the CSRF cookie. Anonymous -> 403 (expected).
  let res = http.get(`${API}/session/`, {
    headers: { Accept: 'application/json' },
    tags: { name: 'session_anon' },
    responseCallback: EXPECT_ANON_SESSION,
  });
  recordResponse('session_anon', res);
  expectStatus(res, [403, 200], 'session_anon');
  if (!refreshCsrf()) {
    throw new Error(
      `No CSRF cookie "${CSRF_COOKIE}" after GET /api/v1/session/ (status ${res.status}). Check CSRF_COOKIE / BASE_URL.`,
    );
  }

  // 2) allauth login. 401 means a pending flow (MFA / verify email) and is a failure for load testing.
  res = allauthPost('/auth/login', { email, password: PASSWORD }, 'login');
  if (!expectStatus(res, [200], 'login')) {
    const body = typeof res.body === 'string' ? res.body.slice(0, 200) : '';
    throw new Error(`Login failed for ${email}: HTTP ${res.status} ${body}`);
  }
  refreshCsrf(); // Django rotates the CSRF cookie on login.

  // 3) Session -> active organisation (bootstrap when none is active).
  res = apiGet('/session/', 'session');
  expectStatus(res, [200], 'session');
  let payload = safeJson(res);
  if (!payload || !payload.active) {
    res = apiPost('/session/bootstrap/', {}, 'bootstrap');
    expectStatus(res, [200], 'bootstrap');
    payload = safeJson(res);
  }
  if (!payload || !payload.active) {
    throw new Error(`No active organisation for ${email} after bootstrap (HTTP ${res.status}).`);
  }

  const now = Date.now();
  session = { email, active: payload.active, loginAt: now, authAt: now };
  loginDuration.add(now - started, { org: user.org || '', size: user.size || '' });
  return session;
}

/** Best-effort logout (allauth answers 401 once the session is gone) and jar reset. */
export function logout() {
  const res = http.del(`${ALLAUTH}/auth/session`, null, {
    headers: { Accept: 'application/json', [CSRF_HEADER]: currentCsrf() },
    tags: { name: 'logout' },
    responseCallback: EXPECT_LOGOUT,
  });
  recordResponse('logout', res);
  try {
    http.cookieJar().clear(`${BASE}/`);
  } catch (e) {
    /* older k6 without CookieJar.clear: cookies get overwritten by the next login anyway */
  }
  session = null;
  csrfCache = '';
}

/**
 * Log in once per VU. When a VU is reused by a different scenario that picked a different user,
 * the previous session is dropped first (allauth returns 409 for "already authenticated").
 */
export function ensureLoggedIn(user) {
  if (session && session.email === user.email) return session;
  if (session) logout();
  return login(user);
}

/** allauth re-authentication (password only) for reauth-guarded actions such as creating an export. */
export function reauthenticate() {
  const res = allauthPost('/auth/reauthenticate', { password: PASSWORD }, 'reauth');
  const ok = expectStatus(res, [200], 'reauth');
  refreshCsrf();
  if (ok && session) session.authAt = Date.now();
  return ok;
}

/** Re-authenticate when the login is older than the recent-auth window of the server (10 min; we use 8). */
export function ensureRecentAuth(user) {
  if (!session || session.email !== user.email) ensureLoggedIn(user);
  if (Date.now() - session.authAt >= RECENT_AUTH_MAX_AGE_MS) reauthenticate();
  return session;
}

/** Extract the cursor from a DRF cursor-pagination `next` URL (rebuilt against BASE so proxies do not matter). */
export function cursorOf(nextUrl) {
  if (!nextUrl) return null;
  const m = /[?&]cursor=([^&]+)/.exec(nextUrl);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch (e) {
    return m[1];
  }
}
