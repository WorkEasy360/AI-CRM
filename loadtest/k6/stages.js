/**
 * k6 `options` per STAGE.
 *
 *   baseline  10 VUs constant for 2 min
 *   moderate  50 VUs: ramp 1m up, hold 4m, 1m down
 *   high      150 VUs: ramp 2m up, hold 5m, 1m down
 *   spike     20 VUs for 2m -> 100 VUs for 2m -> 20 VUs for 3m (burst is a second set of scenarios
 *             with startTime 2m, which gives an instant jump instead of a ramp)
 *   soak      30 VUs for SOAK_MINUTES (default 30)
 *   e         largeTenant only (E_VUS, default 20; E_MINUTES, default 5)
 *   g         importExportWhileBrowsing (G_IO_VUS, default 3) + browse (G_BROWSE_VUS, default 30), G_MINUTES (10)
 *   h         reportWhilePipeline (H_REPORT_VUS, default 3) + moveDeal (H_PIPELINE_VUS, default 20), H_MINUTES (10)
 *
 * The mixed stages split their VU budget by weight: browse 50 %, moveDeal 15 %, search 15 %,
 * dashboardHeavy 10 %, multiTenant 10 % (largest-remainder rounding, every scenario gets >= 1 VU).
 *
 * Thresholds never abort the run: we want the measurements even when they fail.
 */

export const STAGE = (__ENV.STAGE || 'baseline').toLowerCase();

const SOAK_MINUTES = Number(__ENV.SOAK_MINUTES || 30);
const envInt = (name, fallback) => {
  const v = parseInt(__ENV[name], 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const SCENARIO_MIX = [
  ['browse', 0.5],
  ['moveDeal', 0.15],
  ['search', 0.15],
  ['dashboardHeavy', 0.1],
  ['multiTenant', 0.1],
];

/** Largest-remainder apportionment of `total` VUs over SCENARIO_MIX; every scenario gets at least one. */
export function splitVUs(total, mix) {
  const m = mix || SCENARIO_MIX;
  if (total <= 0) return m.reduce((acc, [name]) => ((acc[name] = 0), acc), {});
  const exact = m.map(([name, w]) => ({ name, exact: total * w }));
  const out = {};
  let assigned = 0;
  for (const e of exact) {
    out[e.name] = Math.max(1, Math.floor(e.exact));
    assigned += out[e.name];
  }
  const byRemainder = exact
    .map((e) => ({ name: e.name, rem: e.exact - Math.floor(e.exact) }))
    .sort((a, b) => b.rem - a.rem);
  let i = 0;
  while (assigned < total) {
    out[byRemainder[i % byRemainder.length].name] += 1;
    assigned += 1;
    i += 1;
  }
  return out;
}

const COMMON_SCENARIO = { gracefulStop: '30s' };

function constantMix(total, duration, extra) {
  const split = splitVUs(total);
  const scenarios = {};
  for (const [name] of SCENARIO_MIX) {
    scenarios[name + ((extra && extra.suffix) || '')] = Object.assign(
      { executor: 'constant-vus', exec: name, vus: split[name], duration },
      COMMON_SCENARIO,
      (extra && extra.scenario) || {},
    );
  }
  return scenarios;
}

function rampingMix(stages) {
  const scenarios = {};
  for (const [name] of SCENARIO_MIX) {
    scenarios[name] = Object.assign(
      {
        executor: 'ramping-vus',
        exec: name,
        startVUs: 0,
        stages: stages.map((s) => ({ duration: s.duration, target: s.target === 0 ? 0 : splitVUs(s.target)[name] })),
        gracefulRampDown: '30s',
      },
      COMMON_SCENARIO,
    );
  }
  return scenarios;
}

function single(exec, vus, minutes, extra) {
  return Object.assign(
    {
      executor: 'ramping-vus',
      exec,
      startVUs: 0,
      stages: [
        { duration: '1m', target: vus },
        { duration: `${Math.max(1, minutes - 1)}m`, target: vus },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
    COMMON_SCENARIO,
    extra || {},
  );
}

export function scenariosFor(stage) {
  switch (stage) {
    case 'baseline':
      return constantMix(10, '2m');
    case 'moderate':
      return rampingMix([
        { duration: '1m', target: 50 },
        { duration: '4m', target: 50 },
        { duration: '1m', target: 0 },
      ]);
    case 'high':
      return rampingMix([
        { duration: '2m', target: 150 },
        { duration: '5m', target: 150 },
        { duration: '1m', target: 0 },
      ]);
    case 'spike':
      return Object.assign(
        constantMix(20, '7m'),
        constantMix(80, '2m', { suffix: '_spike', scenario: { startTime: '2m' } }),
      );
    case 'soak':
      return constantMix(30, `${SOAK_MINUTES}m`);
    case 'e':
      return { largeTenant: single('largeTenant', envInt('E_VUS', 20), envInt('E_MINUTES', 5)) };
    case 'g':
      return {
        browse: single('browse', envInt('G_BROWSE_VUS', 30), envInt('G_MINUTES', 10)),
        importExport: Object.assign(
          {
            executor: 'constant-vus',
            exec: 'importExportWhileBrowsing',
            vus: envInt('G_IO_VUS', 3),
            duration: `${envInt('G_MINUTES', 10)}m`,
            startTime: '30s',
          },
          COMMON_SCENARIO,
        ),
      };
    case 'h':
      return {
        moveDeal: single('moveDeal', envInt('H_PIPELINE_VUS', 20), envInt('H_MINUTES', 10)),
        report: Object.assign(
          {
            executor: 'constant-vus',
            exec: 'reportWhilePipeline',
            vus: envInt('H_REPORT_VUS', 3),
            duration: `${envInt('H_MINUTES', 10)}m`,
            startTime: '30s',
          },
          COMMON_SCENARIO,
        ),
      };
    default:
      throw new Error(`Unknown STAGE "${stage}". Use one of: baseline, moderate, high, spike, soak, e, g, h.`);
  }
}

export const THRESHOLDS = {
  // Real HTTP errors only: 429 (throttled) and 409 on deal moves (conflict) are excluded by responseCallback.
  http_req_failed: ['rate<0.01'],
  'http_req_duration{name:dashboard}': ['p(95)<500'],
  'http_req_duration{name:board}': ['p(95)<500'],
  'http_req_duration{name:contacts_list}': ['p(95)<500'],
  'http_req_duration{name:search}': ['p(95)<500'],
  'http_req_duration{name:deal_detail}': ['p(95)<500'],
  'http_req_duration{name:company_detail}': ['p(95)<500'],
  login_duration: ['p(95)<1500'],
  // Warning-level: throttling means the VU pacing or the users-per-VU ratio is off, not that the API failed.
  throttled: ['count<50'],
  throttled_rate: ['rate<0.01'],
};

/** Peak concurrent VUs of an options object (used to warn about the users-per-VU ratio). */
export function peakVUs(scenarios) {
  let peak = 0;
  for (const key of Object.keys(scenarios)) {
    const s = scenarios[key];
    if (s.executor === 'constant-vus') peak += s.vus;
    else if (s.executor === 'ramping-vus') peak += Math.max(s.startVUs || 0, ...s.stages.map((st) => st.target));
  }
  return peak;
}

export function optionsFor(stage) {
  const scenarios = scenariosFor(stage);
  return {
    scenarios,
    // k6 clears each VU's cookie jar between iterations by default; the session cookie must survive
    // because every VU logs in once (Argon2 is expensive) and keeps browsing.
    noCookiesReset: true,
    thresholds: THRESHOLDS,
    summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
    tags: { stage },
    userAgent: 'keel-loadtest/k6',
    insecureSkipTLSVerify: true,
    setupTimeout: '60s',
    teardownTimeout: '60s',
    // Cookies are per VU already; keep connection reuse on so we measure the app, not TCP handshakes.
    noConnectionReuse: false,
    noVUConnectionReuse: false,
  };
}

export const options = optionsFor(STAGE);
