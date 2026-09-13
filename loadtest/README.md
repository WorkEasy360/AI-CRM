# Keel CRM load tests (k6)

Reusable [k6](https://k6.io) suite for the Django API behind the Next.js app. Everything lives in
`loadtest/`; nothing here touches the application code.

```
loadtest/
  k6/
    main.js          entry point: options from STAGE, handleSummary -> /results
    stages.js        STAGE -> k6 scenarios/executors + thresholds
    scenarios.js     one exported function per scenario (A-H)
    lib/auth.js      login / bootstrap / re-auth, CSRF, apiGet/apiPost wrappers with logical `name` tags
    lib/data.js      users.json (SharedArray), user selection, random picks, think time
    lib/checks.js    custom metrics (throttled, conflicts, login_duration, ...) and expectStatus()
  run.sh / run.ps1   run one stage through Docker
  collect_metrics.sh sample docker stats / Postgres / Redis / Celery queues during a run
  results/           JSON + text summaries and metrics CSVs (git-ignored)
  users.json         seeded test users (git-ignored; produced by `seed_loadtest`)
```

`./run.sh smoke` runs one iteration of the browse scenario (1 VU) as a connectivity/auth check.

## Why k6

- One static binary (or a 60 MB Docker image); no Python workers, no master/worker topology.
- Scenarios are plain JavaScript with real control flow, so the login handshake, cursor pagination,
  optimistic-concurrency retries and job polling read like the frontend code they mimic.
- Built-in scenario executors (`constant-vus`, `ramping-vus`, `startTime` for spikes), per-VU cookie
  jars, thresholds, `check()`s and custom metrics; per-endpoint percentiles come from the `name` tag.
- Very low per-VU overhead (goroutines, not threads/processes), so 150 VUs run comfortably on a laptop
  next to the stack under test. Locust needs several Python workers for the same request rate and
  its default HTTP client skews latency numbers under load.
- Runs unchanged in Docker (`grafana/k6:0.54.0`) and in CI; JSON summaries are easy to diff run to run.

## Prerequisites

- Docker (the stack under test **and** k6 run in containers; k6 is not installed locally).
- The Keel stack running, e.g. `docker compose --profile full up` (backend on `:8000`, frontend on
  `:3000`, Postgres, Redis, a Celery worker for imports/exports). k6 reaches the host through
  `host.docker.internal` (the runners pass `--add-host=host.docker.internal:host-gateway`).
- Seeded test users and data.

### Seed

```
cd backend && uv run python manage.py seed_loadtest --out ../loadtest/users.json
```

`users.json` looks like:

```json
{
  "password": "shared-password",
  "users": [
    { "email": "ada@small-1.example", "org": "small-1", "size": "small" },
    { "email": "jo@big.example",      "org": "big",     "size": "large" }
  ]
}
```

Seed **at least one user per three peak VUs** (50 users for `high`). Throttles are per *user*
(600 requests/min, 120/min for search and dashboard), so sharing one user between many VUs produces
429s that have nothing to do with capacity. `setup()` prints a warning when the ratio is above 3.
Scenario E needs users with `"size": "large"`; scenario F needs several organisations.

## Running

```
./run.sh <stage> [BASE_URL]          # Git Bash / Linux / macOS
.\run.ps1 <stage> [BASE_URL]         # PowerShell
```

`BASE_URL` defaults to `http://host.docker.internal:8000` (Django directly). Use
`http://host.docker.internal:3000` to go through the Next.js proxy and measure what the browser sees,
or `http://host.docker.internal:8080` with the nginx stand-in from `infra/nginx/loadtest.conf`
(round-robin over two Django instances on `:8000`/`:8001`, ALB-like path routing).

The manual GitHub workflow `.github/workflows/loadtest.yml` runs the same `k6/main.js` against a
staging URL with the production cookie names, taking `users.json` from the `LOADTEST_USERS_JSON`
secret and uploading `results/` as an artifact.

| Stage      | Load model                                                              | Scenarios                                             |
|------------|-------------------------------------------------------------------------|-------------------------------------------------------|
| `baseline` | 10 VUs constant, 2 min                                                  | mix (browse 50 %, moveDeal 15 %, search 15 %, dashboardHeavy 10 %, multiTenant 10 %) |
| `moderate` | 50 VUs: ramp up 1 min, hold 4 min, ramp down 1 min                      | mix                                                   |
| `high`     | 150 VUs: ramp up 2 min, hold 5 min, ramp down 1 min                     | mix                                                   |
| `spike`    | 20 VUs for 2 min, instant jump to 100 VUs for 2 min, back to 20 for 3 min | mix (the burst is a second set of scenarios with `startTime: 2m`) |
| `soak`     | 30 VUs for `SOAK_MINUTES` (default 30)                                  | mix                                                   |
| `e`        | `E_VUS` (20) large-tenant VUs for `E_MINUTES` (5)                       | largeTenant only                                      |
| `g`        | `G_BROWSE_VUS` (30) browsing + `G_IO_VUS` (3) import/export VUs, `G_MINUTES` (10) | browse + importExportWhileBrowsing          |
| `h`        | `H_PIPELINE_VUS` (20) moving deals + `H_REPORT_VUS` (3) report VUs, `H_MINUTES` (10) | moveDeal + reportWhilePipeline         |

Mixed stages split the VU budget by weight with largest-remainder rounding and every scenario gets at
least one VU; `baseline` (10 VUs) runs browse 5, moveDeal 2, search 1, dashboardHeavy 1,
multiTenant 1. The exact split per scenario is printed in the k6 banner.

Environment knobs (all optional): `SESSION_COOKIE` (`keel_session`; production uses
`__Host-keel_session`), `CSRF_COOKIE` (`keel_csrftoken` / `__Host-keel_csrftoken`), `SOAK_MINUTES`,
`E_VUS`, `E_MINUTES`, `G_IO_VUS`, `G_BROWSE_VUS`, `G_MINUTES`, `H_REPORT_VUS`, `H_PIPELINE_VUS`,
`H_MINUTES`, `SEARCH_PREFIXES` (comma list), `IMPORT_ROWS` (25), `JOB_POLL_SECONDS` (2),
`JOB_POLL_MAX_SECONDS` (60), `IO_MIN_ITERATION_SECONDS` (30), `RECENT_AUTH_MINUTES` (8),
`VERBOSE=1` (log every unexpected status with a body excerpt), `K6_ARGS` (extra k6 flags, e.g.
`--http-debug=full`), `K6_IMAGE`.

Examples:

```
./run.sh baseline
./run.sh high http://host.docker.internal:3000
SOAK_MINUTES=60 ./run.sh soak
G_IO_VUS=2 G_BROWSE_VUS=40 ./run.sh g
VERBOSE=1 ./run.sh e
```

Note on `__Host-` cookies: browsers and k6 only accept them over HTTPS. When the target uses the
production cookie names, `BASE_URL` must be `https://...` (self-signed certificates are accepted:
`insecureSkipTLSVerify` is on).

### Server metrics during a run

In a second terminal:

```
./collect_metrics.sh              # every 5 s until Ctrl-C
INTERVAL=2 ./collect_metrics.sh
```

Writes `results/metrics-<timestamp>.csv` in long format (`timestamp,source,metric,value`) with
`docker stats` CPU/memory for every `keel-*` container, Postgres connection counts
(`pg_stat_activity`, total and `active`), Redis `used_memory_human` / `connected_clients`, and Celery
queue depths (`LLEN` on broker db 1) for `default`, `imports`, `exports`, `notifications`, `reports`.
The compose file currently runs one worker on `default` only; the other queues read 0 until they are
introduced. Container names (`keel-postgres-1`, `keel-redis-1`, prefix `keel-`) and the database name
are overridable through `PG_CONTAINER`, `REDIS_CONTAINER`, `CONTAINER_PREFIX`, `DB_NAME`.

## Scenarios

Every scenario logs in **once per VU** (first iteration) and keeps the cookie session in a per-VU
module variable; `login_duration` measures the full handshake (CSRF seed, allauth login, session,
bootstrap when the user has no active organisation). Think time between iterations is 1-3 s.

| Id | Function                     | Flow                                                                                          |
|----|------------------------------|-----------------------------------------------------------------------------------------------|
| A  | `browse`                     | dashboard 30d -> deals board -> contacts list (50) -> one company detail -> one deal detail    |
| B  | `moveDeal`                   | board -> move a random deal to a different *open* stage of the same pipeline (`POST deals/{id}/stage/` with `stage_id` + `version`) -> move it back with the new version. 409 = `conflicts`, not an error |
| C  | `search`                     | 5 searches with realistic prefixes (`ada`, `acme`, `jo`, ... ; `SEARCH_PREFIXES`) with typing pauses |
| D  | `dashboardHeavy`             | dashboard for 7d, 30d, 90d, 365d; 2-4 s think time (dashboard shares the 120/min search scope) |
| E  | `largeTenant`                | A with `size == "large"` users only and three pages of contacts (cursor pagination)           |
| F  | `multiTenant`                | A with VUs dealt round-robin across every organisation in `users.json`                        |
| G  | `importExportWhileBrowsing`  | contacts export (`POST exports/contacts/` -> poll -> download with `redirects: 0`, 200 or 302 accepted) then a 25-row contacts import (multipart upload -> `start/` with explicit mapping -> poll). Iterations are padded to 30 s. Runs next to `browse` in `STAGE=g` |
| H  | `reportWhilePipeline`        | "report generation" = `dashboard/?period=365d` + `POST exports/deals/` (there is no separate report endpoint) while other VUs run `moveDeal` in `STAGE=h` |

Logical endpoint names used for the `name` tag (so UUIDs never leak into metric names):
`session_anon`, `login`, `reauth`, `logout`, `session`, `bootstrap`, `dashboard`, `board`,
`contacts_list`, `contacts_page`, `contacts_count`, `contact_detail`, `companies_list`,
`company_detail`, `deals_list`, `deal_detail`, `deal_move`, `products_list`, `search`,
`export_create`, `export_status`, `export_download`, `import_upload`, `import_start`,
`import_status`.

## Thresholds

Thresholds are evaluated and reported but **never abort a run** (no `abortOnFail`):

| Threshold                                   | Target        |
|---------------------------------------------|---------------|
| `http_req_failed`                           | rate < 1 %    |
| `http_req_duration{name:dashboard}`         | p95 < 500 ms  |
| `http_req_duration{name:board}`             | p95 < 500 ms  |
| `http_req_duration{name:contacts_list}`     | p95 < 500 ms  |
| `http_req_duration{name:search}`            | p95 < 500 ms  |
| `http_req_duration{name:deal_detail}`       | p95 < 500 ms  |
| `http_req_duration{name:company_detail}`    | p95 < 500 ms  |
| `login_duration`                            | p95 < 1500 ms |
| `throttled` (429 count)                     | < 50 (warning) |
| `throttled_rate` (429 / all requests)       | < 1 % (warning) |

`http_req_failed` counts real errors only: 429 responses are "expected" through
`http.setResponseCallback` and counted in `throttled`; 409 on `deal_move` is expected and counted in
`conflicts`. `api_failures` counts responses outside the status set each call expects (e.g. a 500 on
the board, or a 401 from allauth meaning the user has a pending MFA/verification flow).

## Results

Each run writes two files to `results/` (mounted at `/results` in the container):

- `<stage>-<ISO timestamp>.json`: the full k6 summary (every metric with all trend stats, thresholds,
  checks, per-scenario groups) for archiving and diffing.
- `<stage>-<timestamp>.txt`: headline (requests, failure %, 429/409 counts, login p95), a per-endpoint
  table (count, rps, p50, p95, p99, max, error %), the threshold report (PASS/FAIL per expression) and
  the standard k6 text summary. The same text is printed to stdout.

The per-endpoint table is built from custom `ep_<name>_*` metrics, because k6 only materialises tagged
sub-metrics (`http_req_duration{name:x}`) in the summary when a threshold references them.

Custom metrics: `throttled`, `throttled_rate`, `conflicts`, `login_duration`, `api_failures`,
`job_duration` (export/import create -> completed, tagged `kind`), `jobs_failed` (failed or timed out
after 60 s), `job_quota_hits` (429 `too_many_active_jobs`, see below).

### Results table template

| Stage    | Date | BASE_URL | Peak VUs | Requests | rps | Failed % | 429 | 409 | login p95 | dashboard p95 | board p95 | contacts p95 | search p95 | deal p95 | company p95 | Thresholds | Notes |
|----------|------|----------|---------:|---------:|----:|---------:|----:|----:|----------:|--------------:|----------:|-------------:|-----------:|---------:|------------:|------------|-------|
| baseline |      |          |       10 |          |     |          |     |     |           |               |           |              |            |          |             |            |       |
| moderate |      |          |       50 |          |     |          |     |     |           |               |           |              |            |          |             |            |       |
| high     |      |          |      150 |          |     |          |     |     |           |               |           |              |            |          |             |            |       |
| spike    |      |          |      100 |          |     |          |     |     |           |               |           |              |            |          |             |            |       |
| soak     |      |          |       30 |          |     |          |     |     |           |               |           |              |            |          |             |            |       |
| e        |      |          |       20 |          |     |          |     |     |           |               |           |              |            |          |             |            |       |
| g        |      |          |       33 |          |     |          |     |     |           |               |           |              |            |          |             |            |       |
| h        |      |          |       23 |          |     |          |     |     |           |               |           |              |            |          |             |            |       |

Pair each row with the matching `metrics-*.csv` (peak backend CPU, peak Postgres active connections,
max Celery queue depth) when you write up a run.

## Caveats and how to read the numbers

- **Login is Argon2.** One login costs ~100-300 ms of CPU on the backend by design. The suite logs in
  once per VU, so ramp-up phases show a login burst (`login_duration`, `login` row) that is not
  representative of steady state. Do not scale VUs faster than the backend can hash; if `login`
  p95 explodes during ramp-up, lengthen the ramp.
- **Throttles are per user.** `user` scope 600/min, `search` scope (search *and* dashboard) 120/min,
  `sensitive` scope (imports, exports, session bootstrap, organisation switching) 30/min. VU pacing is
  designed so one VU stays below these (browse ~6 requests per 2.5-4 s, search 5 per ~4.5 s,
  dashboardHeavy 4 per ~5 s, one export+import cycle per 30 s). Many VUs on the same user add up;
  seed enough users. 429s are reported as `throttled`, not as failures.
- **Job polling counts against the sensitive scope.** Export/import status polls (every 2 s, 60 s max)
  hit the same 30/min bucket as creating the job. A slow Celery worker therefore shows up as
  `throttled` on `export_status`/`import_status` and as `jobs_failed{reason:timeout}`.
- **Per-organisation job quota.** The backend caps pending+running import/export jobs per organisation
  (`MAX_ACTIVE_JOBS_PER_ORG`, default 3) with a 429 `too_many_active_jobs`. Those are counted in
  `job_quota_hits` (and in `throttled`). Keep `G_IO_VUS` <= the quota unless the VUs land in different
  organisations (users are dealt round-robin, so with users from several orgs they usually do).
- **Exports require recent authentication** (10 min window). The suite re-authenticates a VU after
  8 min (`reauth` row) and retries once on 403, so long G/H runs keep working.
- **Imports add data.** Every G iteration creates 25 contacts (`lt-*@loadtest.invalid`) in the
  importing user's organisation. Re-seed or clean up after long runs; the contacts list and search
  numbers drift upwards otherwise.
- **Large tenant (E).** Expect the board, dashboard and search rows to be the slow ones: the board
  runs one LIMIT query per stage plus aggregates over the whole pipeline, the dashboard aggregates the
  period, search is trigram/tsvector over the tenant. Contacts pagination (`contacts_page`) should
  stay flat across pages (cursor, not offset). If `contacts_page` p95 rises with page number, the
  cursor index is not being used.
- **Move-deal conflicts (409) are expected** when two VUs pick the same deal; they are counted in
  `conflicts` and skipped, not retried, so the count is a measure of contention, not of errors.
- **Docker on Windows.** The runners use `MSYS_NO_PATHCONV=1` and `pwd -W` so Git Bash does not
  rewrite `/scripts` and `/results`. Docker Desktop leaves an empty `k6/users.json` mountpoint behind
  after each run; it is git-ignored and harmless. Latency includes the Docker Desktop network hop
  (`host.docker.internal`); compare stages against each other, not against numbers from a native run.
- **Through Next.js (`:3000`)** the API is proxied by the Node server; expect a few ms more per request
  and Node CPU in `docker stats`. Use `:8000` to isolate Django.
- `k6 archive` / `k6 inspect` resolve the `k6-summary` jslib import over the network on first use.

## Validating the scripts without running a test

```
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/loadtest/k6:/scripts" -v "$(pwd -W)/loadtest/users.json:/scripts/users.json:ro" \
  -e STAGE=high grafana/k6:0.54.0 inspect /scripts/main.js
```

`inspect` runs the init context (imports, `users.json` parsing, `options` construction) and prints
the resolved options without sending traffic. Repeat with each `STAGE` to check every executor config.
