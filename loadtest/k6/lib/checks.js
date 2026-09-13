/**
 * Custom metrics and status assertions shared by every scenario.
 *
 * - `throttled`       Counter of 429 responses (reported separately, never an error).
 * - `throttled_rate`  Rate of 429 responses over all requests (warning threshold: < 1 %).
 * - `conflicts`       Counter of 409 responses on deal moves (concurrent edit, not an error).
 * - `login_duration`  Trend of the full login handshake (CSRF seed + allauth login + session/bootstrap).
 * - `api_failures`    Counter of responses whose status was not in the expected set.
 * - `job_duration`    Trend of export/import job wall time (create -> completed), tagged by kind.
 * - `jobs_failed`     Counter of export/import jobs that ended `failed` or timed out.
 * - `job_quota_hits`  Counter of 429 `too_many_active_jobs` answers (per-org active-job quota, not the rate limit).
 * - `ep_<name>_*`     Per-logical-endpoint duration / count / failure metrics used to build the
 *                     per-endpoint table in the text summary (k6 only exposes tagged sub-metrics in
 *                     the summary when a threshold references them, so we keep our own).
 */
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

export const throttled = new Counter('throttled');
export const throttledRate = new Rate('throttled_rate');
export const conflicts = new Counter('conflicts');
export const loginDuration = new Trend('login_duration', true);
export const apiFailures = new Counter('api_failures');
export const jobDuration = new Trend('job_duration', true);
export const jobsFailed = new Counter('jobs_failed');
export const jobQuotaHits = new Counter('job_quota_hits');

/** Logical endpoint names. Every request made through lib/auth.js must use one of these as its `name` tag. */
export const ENDPOINTS = [
  'session_anon',
  'login',
  'reauth',
  'logout',
  'session',
  'bootstrap',
  'dashboard',
  'board',
  'pipelines',
  'contacts_list',
  'contacts_page',
  'contacts_count',
  'contact_detail',
  'companies_list',
  'company_detail',
  'deals_list',
  'deal_detail',
  'deal_move',
  'products_list',
  'search',
  'export_create',
  'export_status',
  'export_download',
  'import_upload',
  'import_start',
  'import_status',
  'other',
];

export const endpointMetrics = {};
for (const name of ENDPOINTS) {
  endpointMetrics[name] = {
    duration: new Trend(`ep_${name}_duration`, true),
    count: new Counter(`ep_${name}_count`),
    failed: new Rate(`ep_${name}_failed`),
  };
}

/**
 * Record one response against the per-endpoint metrics and the throttle counters.
 * Whether it counts as a failure is decided by expectStatus, because the expected set differs per call.
 */
export function recordResponse(name, res) {
  const m = endpointMetrics[name] || endpointMetrics.other;
  m.duration.add(res.timings.duration);
  m.count.add(1);
  const is429 = res.status === 429;
  throttledRate.add(is429);
  if (is429) {
    throttled.add(1, { name });
    if (typeof res.body === 'string' && res.body.indexOf('too_many_active_jobs') !== -1) {
      jobQuotaHits.add(1, { name });
    }
  }
}

/**
 * Assert `res.status` is one of `allowed`. Records a k6 check, the per-endpoint failure rate and the
 * `api_failures` counter. 429 is never a failure (it is already counted as `throttled`).
 * Returns true when the status was acceptable so callers can bail out of a flow cleanly.
 */
export function expectStatus(res, allowed, name) {
  const ok = allowed.indexOf(res.status) !== -1;
  const label = `${name}: status in [${allowed.join(', ')}]`;
  const is429 = res.status === 429;
  check(res, { [label]: () => ok || is429 }, { name });
  const m = endpointMetrics[name] || endpointMetrics.other;
  const failed = !ok && !is429;
  m.failed.add(failed);
  if (failed) {
    apiFailures.add(1, { name, status: String(res.status) });
    if (__ENV.VERBOSE) {
      const body = typeof res.body === 'string' ? res.body.slice(0, 300) : '';
      const req = res.request ? `${res.request.method} ${res.request.url}` : '';
      console.warn(`[${name}] unexpected ${res.status} ${req} ${body}`);
    }
  }
  return ok;
}

/** Parse a JSON body defensively; returns null on any error. */
export function safeJson(res) {
  try {
    return res.json();
  } catch (e) {
    return null;
  }
}
