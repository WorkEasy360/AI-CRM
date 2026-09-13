/**
 * Test data: seeded users (loadtest/users.json, mounted at /scripts/users.json) and random picks.
 *
 * users.json format (written by `manage.py seed_loadtest`):
 *   {"password": "<shared password>", "users": [{"email": "...", "org": "<org slug>", "size": "small|large"}]}
 */
import { sleep } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';

// Resolved relative to this module (k6/lib/), i.e. /scripts/users.json in Docker.
const USERS_FILE = __ENV.USERS_FILE || '../users.json';

// SharedArray runs the loader once and shares the parsed result between VUs (memory-cheap at 150+ VUs).
const CONFIG = new SharedArray('loadtest-config', () => {
  const parsed = JSON.parse(open(USERS_FILE));
  if (!parsed || !Array.isArray(parsed.users) || parsed.users.length === 0) {
    throw new Error(`${USERS_FILE} has no users; run the seed command first (see loadtest/README.md).`);
  }
  if (typeof parsed.password !== 'string' || !parsed.password) {
    throw new Error(`${USERS_FILE} has no shared "password".`);
  }
  return [{ password: parsed.password }];
});

export const USERS = new SharedArray('loadtest-users', () => JSON.parse(open(USERS_FILE)).users);

export const PASSWORD = CONFIG[0].password;

export const ORGS = (() => {
  const seen = {};
  const out = [];
  for (let i = 0; i < USERS.length; i++) {
    const org = USERS[i].org;
    if (!seen[org]) {
      seen[org] = true;
      out.push(org);
    }
  }
  return out;
})();

export const LARGE_USER_COUNT = USERS.filter((u) => u.size === 'large').length;

/** Global VU id (1-based, unique across all scenarios of a run). Only valid inside VU code. */
function vuId() {
  return exec.vu.idInTest;
}

/** Deterministic user for this VU: VUs are dealt round-robin over the (optionally filtered) pool. */
export function userForVU(filter) {
  const pool = filter ? USERS.filter(filter) : USERS;
  if (pool.length === 0) throw new Error('No seeded users match the requested filter.');
  return pool[(vuId() - 1) % pool.length];
}

/**
 * Users allowed to import/export (scenarios G, H): owners and sales managers. Sales representatives are
 * correctly refused (403) by RBAC, which must not be measured as an API failure.
 */
export function ioUser() {
  return userForVU((u) => !u.role || u.role === 'owner' || u.role === 'sales_manager');
}

/** Only users of `size == "large"` tenants (scenario E). */
export function largeTenantUser() {
  return userForVU((u) => u.size === 'large');
}

/**
 * Spread VUs evenly across every organisation (scenario F): VU 1 -> org 1, VU 2 -> org 2, ...,
 * then round-robin over the users of that organisation.
 */
export function userSpreadByOrg() {
  const id = vuId() - 1;
  const org = ORGS[id % ORGS.length];
  const pool = USERS.filter((u) => u.org === org);
  return pool[Math.floor(id / ORGS.length) % pool.length];
}

export function pick(arr) {
  if (!arr || arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

export function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Realistic search prefixes. The seed data uses common first names / company stems, so short
 * prefixes hit the trigram / tsvector indexes the way a user typing into the search box would.
 * Override with -e SEARCH_PREFIXES=a,b,c.
 */
export const SEARCH_PREFIXES = (__ENV.SEARCH_PREFIXES || 'ada,acme,jo,ma,sam,ali,tech,glob,nor,li,ro,sol')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Think time between user actions (seconds). Default 1-3 s, per the throttle-budget design. */
export function thinkTime(min, max) {
  const lo = min === undefined ? 1 : min;
  const hi = max === undefined ? 3 : max;
  sleep(lo + Math.random() * (hi - lo));
}

/** Short pause between rapid actions (typing, clicking through tabs). */
export function shortPause() {
  sleep(0.3 + Math.random() * 0.5);
}
