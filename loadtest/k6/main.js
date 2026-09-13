/**
 * Entry point: `k6 run -e STAGE=<stage> -e BASE_URL=<origin> /scripts/main.js`
 *
 * Writes /results/<STAGE>-<ISO timestamp>.json (full k6 summary data) and
 * /results/<STAGE>-<timestamp>.txt (k6 text summary + per-endpoint table + threshold report).
 */
import http from 'k6/http';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.1.0/index.js';

import { STAGE, optionsFor, peakVUs, scenariosFor } from './stages.js';
import { API, BASE, CSRF_COOKIE, SESSION_COOKIE } from './lib/auth.js';
import { LARGE_USER_COUNT, ORGS, USERS } from './lib/data.js';
import { ENDPOINTS } from './lib/checks.js';

export {
  browse,
  moveDeal,
  search,
  dashboardHeavy,
  largeTenant,
  multiTenant,
  importExportWhileBrowsing,
  reportWhilePipeline,
} from './scenarios.js';

export const options = optionsFor(STAGE);

const RESULTS_DIR = (__ENV.RESULTS_DIR || '/results').replace(/\/+$/, '');

export function setup() {
  // k6 swaps the exported `options` for its consolidated form at runtime; rebuild the stage definition instead.
  const peak = peakVUs(scenariosFor(STAGE));
  console.log(`stage=${STAGE} base=${BASE} users=${USERS.length} orgs=${ORGS.length} large-users=${LARGE_USER_COUNT} peakVUs=${peak}`);
  console.log(`cookies: session=${SESSION_COOKIE} csrf=${CSRF_COOKIE}`);
  if (USERS.length > 0 && peak / USERS.length > 3) {
    console.warn(
      `Only ${USERS.length} seeded users for ${peak} VUs (${(peak / USERS.length).toFixed(1)} VUs per user). ` +
        'Throttles are per user (600/min, search+dashboard 120/min): expect 429s. Seed more users.',
    );
  }
  if (STAGE === 'e' && LARGE_USER_COUNT === 0) {
    throw new Error('STAGE=e needs users with size == "large" in users.json.');
  }
  // Fail fast when the origin is unreachable: anonymous session probe must answer 403 (or 200).
  const res = http.get(`${API}/session/`, {
    headers: { Accept: 'application/json' },
    tags: { name: 'session_anon' },
    responseCallback: http.expectedStatuses(200, 403),
  });
  if (res.status !== 403 && res.status !== 200) {
    throw new Error(`Cannot reach ${API}/session/ (status ${res.status}, error "${res.error}"). Check BASE_URL / --add-host.`);
  }
  return { startedAt: new Date().toISOString() };
}

// ------------------------------------------------------------------------------------------ summary

function fmt(n, digits) {
  if (n === undefined || n === null || Number.isNaN(n)) return '-';
  return Number(n).toFixed(digits === undefined ? 1 : digits);
}

function pad(s, width, right) {
  s = String(s);
  if (s.length >= width) return s;
  const fill = ' '.repeat(width - s.length);
  return right ? fill + s : s + fill;
}

function endpointTable(data) {
  const seconds = (data.state && data.state.testRunDurationMs ? data.state.testRunDurationMs : 0) / 1000;
  const cols = [
    ['endpoint', 18, false],
    ['count', 8, true],
    ['rps', 8, true],
    ['p50 ms', 9, true],
    ['p95 ms', 9, true],
    ['p99 ms', 9, true],
    ['max ms', 9, true],
    ['err %', 7, true],
  ];
  const lines = [];
  lines.push(cols.map(([h, w, r]) => pad(h, w, r)).join('  '));
  lines.push(cols.map(([, w]) => '-'.repeat(w)).join('  '));
  let total = 0;
  for (const name of ENDPOINTS) {
    const count = data.metrics[`ep_${name}_count`];
    const dur = data.metrics[`ep_${name}_duration`];
    const failed = data.metrics[`ep_${name}_failed`];
    const n = count && count.values ? count.values.count : 0;
    if (!n) continue;
    total += n;
    const v = (dur && dur.values) || {};
    const row = [
      name,
      n,
      fmt(seconds ? n / seconds : 0, 2),
      fmt(v.med),
      fmt(v['p(95)']),
      fmt(v['p(99)']),
      fmt(v.max),
      fmt(failed && failed.values ? failed.values.rate * 100 : 0, 2),
    ];
    lines.push(row.map((c, i) => pad(c, cols[i][1], cols[i][2])).join('  '));
  }
  lines.push('');
  lines.push(`total requests: ${total}  duration: ${fmt(seconds, 0)} s  overall rps: ${fmt(seconds ? total / seconds : 0, 2)}`);
  return lines.join('\n');
}

function thresholdReport(data) {
  const lines = [];
  let failed = 0;
  for (const name of Object.keys(data.metrics)) {
    const th = data.metrics[name].thresholds;
    if (!th) continue;
    for (const expr of Object.keys(th)) {
      const ok = th[expr].ok;
      if (!ok) failed += 1;
      lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${expr}`);
    }
  }
  lines.sort();
  return `${failed === 0 ? 'all thresholds passed' : failed + ' threshold(s) failed'}\n${lines.join('\n')}`;
}

function metricValue(data, name, key) {
  const m = data.metrics[name];
  return m && m.values ? m.values[key] : undefined;
}

function headline(data, startedAt) {
  const seconds = (data.state && data.state.testRunDurationMs ? data.state.testRunDurationMs : 0) / 1000;
  return [
    `Keel CRM load test  stage=${STAGE}  base=${BASE}`,
    `started=${startedAt}  finished=${new Date().toISOString()}  duration=${fmt(seconds, 0)} s`,
    `requests=${metricValue(data, 'http_reqs', 'count') || 0}  failed=${fmt((metricValue(data, 'http_req_failed', 'rate') || 0) * 100, 2)} %` +
      `  throttled(429)=${metricValue(data, 'throttled', 'count') || 0}  conflicts(409)=${metricValue(data, 'conflicts', 'count') || 0}` +
      `  api_failures=${metricValue(data, 'api_failures', 'count') || 0}  jobs_failed=${metricValue(data, 'jobs_failed', 'count') || 0}`,
    `login p95=${fmt(metricValue(data, 'login_duration', 'p(95)'))} ms  iterations=${metricValue(data, 'iterations', 'count') || 0}` +
      `  peak VUs=${metricValue(data, 'vus_max', 'max') || 0}`,
  ].join('\n');
}

export function handleSummary(data) {
  const startedAt = (data.setup_data && data.setup_data.startedAt) || '';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${RESULTS_DIR}/${STAGE}-${ts}`;

  // Hide the per-endpoint helper metrics from the stock k6 summary; the table below presents them.
  const trimmed = Object.assign({}, data, { metrics: {} });
  for (const name of Object.keys(data.metrics)) {
    if (!name.startsWith('ep_')) trimmed.metrics[name] = data.metrics[name];
  }

  const text = [
    headline(data, startedAt),
    '',
    '== per endpoint ==',
    endpointTable(data),
    '',
    '== thresholds ==',
    thresholdReport(data),
    '',
    '== k6 summary ==',
    textSummary(trimmed, { indent: ' ', enableColors: false }),
    '',
  ].join('\n');

  return {
    [`${base}.json`]: JSON.stringify(data, null, 2),
    [`${base}.txt`]: text,
    stdout: text,
  };
}
