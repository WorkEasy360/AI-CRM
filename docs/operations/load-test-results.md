# Load-test results

Every number below was measured; nothing is extrapolated. Re-run the suite (see
[`load-testing.md`](load-testing.md)) after any change to the runtime, the hot endpoints or the infrastructure,
and append a dated section. The verified capacity is what the latest section says for the environment it names.

## 2026-09-13 - local reference environment

**Environment.** One Windows 11 laptop, Docker Desktop (24 vCPU visible, 8 GB memory for the Docker VM).
`docker-compose.loadtest.yml`: nginx (ALB path rules) -> 2 x gunicorn (2 workers x 4 threads each, `DB_POOL=true`,
pool size 4 per process), Next.js standalone, worker (default, notifications), worker-heavy (imports, exports,
reports), beat, PostgreSQL 16, Redis 7. k6 0.54 ran in a container on the same machine, so the load generator,
the load balancer and every service shared one CPU budget: absolute latencies are pessimistic compared with
Fargate tasks that own their vCPUs, and the throughput ceiling is the laptop's, not the architecture's.

**Data.** 16 tenants: 15 small (300 contacts, 100 companies, 200 deals, 30 products) and 1 large (25,000
contacts, 5,000 companies, 12,000 deals, 500 products), plus 6 duplicate tenants of the same shapes created by an
early seeding mistake (they only add rows). 192 users (owner, sales manager, 10 own-scope sales representatives
per tenant). Contacts table ~85k rows, deals ~36k rows.

**Code.** This commit (dashboard cache, prefix search with `ts_rank` on the stored vector, board limited to
50 cards per stage, bounded counts, queue split, psycopg pool).

### Stage results (first chain, 30 users; 429s from per-user throttles counted separately, never as errors)

| Stage | Peak VUs | Requests | req/s | Error rate | 429 (throttle) | p50 | p95 | p99 (worst endpoint) |
|---|---|---|---|---|---|---|---|---|
| baseline | 10 | 1,457 | 11.8 | 0.00 % | 0 | board 64 ms, others 12-26 ms | board 122 ms, others 19-34 ms | board 179 ms |
| moderate | 50 | 72,564 | 200 | 0.00 % | 28,353 | board 119 ms, others 19-31 ms | board 274 ms, others 78-101 ms | board 373 ms |
| high | 150 | 153,720 | 318 | 0.00 % | 60,866 | board 453 ms, others 244-291 ms | board 1.12 s, others 0.83-0.90 s | 1.46 s |
| spike (20 -> 100 -> 20) | 100 | 119,394 | 281 | 0.03 % (32 logins) | 54,064 | board 146 ms, others 27-41 ms | board 430 ms, others 242-272 ms | 574 ms |
| e: large tenant | 20 | 8,029 | 24 | 0.00 % | 0 | board 190 ms, contacts 31 ms, dashboard 12 ms | board 402 ms, contacts 116 ms, dashboard 64 ms | board 628 ms |

Login (Argon2 password hashing, deliberately expensive): p95 538 ms at baseline, 460 ms moderate, 2.26 s under
the 150-VU high stage, 1.62 s during the spike. Every login is CPU-bound and shares the same cores as the API on
this machine.

Server side during the first chain (5 s samples, peaks): backend containers 4.2-4.8 cores each at the top of
the high stage, 295 MB RSS average (max 486 MB); PostgreSQL 1.6 cores peak, 152 MB; Redis 0.12 cores peak,
18 MB; nginx 0.17 cores; Next.js idle (API traffic bypasses it, as behind the ALB). PostgreSQL connections:
18 total / 6 active at peak, exactly the pool cap (2 tasks x 2 workers x 4) plus workers. Redis clients: 49.
Celery queues stayed empty (no jobs in these stages).

Readings:

- The 32 spike failures are login 429s from allauth's per-IP login limit (20/min/IP): all 100 virtual users
  share one source address and logged in within the same second. Behind CloudFront every client has its own
  address; with a single address the limit does exactly what it is for.
- The 39-40 % of 429s in moderate/high are the per-user API throttles (600/min per user, 120/min for search and
  dashboard): 50-150 virtual users spread over only 30 accounts generated 400+ requests per minute per account.
  They are fast responses and protect the database; they also mean the "high" stage measured the throttle
  layer as much as the compute layer. The second chain below uses 192 accounts.
- With 2 x 8 request threads, the machine saturates at roughly 300-320 requests/s of authenticated CRM calls
  with p95 near 1 s. Errors stayed at zero because the pool timeout, statement timeout and thread limits queue
  work briefly instead of failing it; nothing hung.
- Large-tenant browsing (25k contacts, 12k deals): board p95 402 ms is the slowest interactive call; contacts
  list p95 116 ms, dashboard p95 64 ms (cached after the first hit per member).

### Second chain (192 users)

Same environment and code, ~1 h later, after the user pool was widened to 192 accounts (10 representatives per
tenant) so that fewer virtual users share a throttle bucket. The dataset had also grown (duplicate tenants,
contacts ~85k rows), so absolute numbers are not directly comparable with the first chain.

| Stage | Peak VUs | Requests | req/s | Error rate | 429 (throttle) | p95 (board / typical API) | p99 worst |
|---|---|---|---|---|---|---|---|
| moderate | 50 | 53,423 | 147 | 0.00 % | 19,349 (36 %) | 586 ms / 205-248 ms | 863 ms (board) |
| high | 150 | 136,784 | 283 | 0.00 % (1 request) | 51,797 (38 %) | 794 ms / 608-654 ms | 1.05 s (board) |
| soak (15 min) | 30 | 68,124 | 75 | 0.01 % (10 logins) | 19,019 | 213 ms / 46-60 ms | 321 ms (board) |

Soak drift (first vs last 5 s sample over 15 minutes): backend-a RSS 251.8 -> 253.4 MB, backend-b 241.5 ->
243.5 MB, worker-heavy 81.8 -> 82.3 MB, PostgreSQL connections 14 -> 17 (pool warm-up, then flat at the cap),
Redis 2.7 MB flat, Celery queues empty throughout. No leak signature in memory, connections or latency
(soak p95 stayed at 46-60 ms for the typical calls from start to end).

The 36-38 % throttled share persisted with 192 accounts because the `search` and `dashboardHeavy` scenarios
issue 4-5 calls per iteration against the 120/min `search` scope with short think times; that is the suite
being greedy, not the product being slow. It is left as is on purpose: it documents that the per-user throttles
engage well before the database does, which is the intended protection order. The high stage measured
p95 of 0.6-0.8 s at 283 req/s on shared laptop cores with zero errors.

### Job scenarios (G: import/export while browsing, H: report while pipeline in use)

Owners and sales managers run the jobs (sales representatives are correctly refused with 403 by RBAC, which an
earlier version of the suite had counted as failures).

| Stage | VUs | Requests | Error rate | Jobs | Job wall time (p95) | Browsing p95 during the jobs |
|---|---|---|---|---|---|---|
| g: 3 VUs export+import cycles, 30 VUs browsing, 10 min | 33 | 42,415 | 0.00 % | 60 exports + 60 imports, 0 failed | 2.17 s (25-row imports, 300-row exports; poll interval 2 s) | board 195 ms, contacts 52 ms, dashboard 35 ms |
| h: 3 VUs dashboard-365d + deals export, 20 VUs moving deals, 10 min | 23 | 13,973 | 0.00 % | 90 exports, 0 failed; 7 stage-move conflicts (409, expected under contention) | 2.05 s | board 119 ms, dashboard 26 ms |

Heavy-worker CPU peaked at 0.23 cores, queue depth never exceeded 1 (jobs were consumed as fast as they
arrived), PostgreSQL connections 22 at most. Browsing latency with jobs running is indistinguishable from the
soak stage without them: the queue split does isolate heavy work from the interactive path.

A first attempt of these scenarios failed every job with `PermissionError` on the shared Docker volume (root-owned
mount, non-root container). That is exactly the class of problem the S3 backend removes in production; locally the
image now creates `/app/private` with the right owner.

### Failure drills (during a 50-VU moderate run, 6 min, `loadtest/resilience.sh all`)

| Drill | Observed |
|---|---|
| Stop one of two Django instances for 45 s | 6 POST requests (logins, stage moves) answered 502 in the first seconds; GETs were retried on the surviving instance by the proxy. Sessions survived: no user was logged out. |
| Restart the heavy worker | Reconnected in 5 s; no job in flight at that moment; queues empty afterwards. |
| Pause Redis for 20 s | Zero errors: sessions fell back to the database, dashboards recomputed, throttles failed open (`CACHE_FAIL_OPEN`). Celery workers logged a missed heartbeat and reconnected. |
| Stop the Next.js container for 30 s | API traffic unaffected (it never passes through the web tier). |
| Whole window | 94 of 44,295 requests failed (0.21 %); most were connection resets from restarting the local nginx after each container swap, an artifact of the static-upstream stand-in. An ALB registers and drains targets without a restart. |

Not reproduced locally: database connection saturation (the pool cap held at 18-22 connections in every stage,
so saturation would require deliberately shrinking `DB_POOL_MAX_SIZE`; see `docs/operations/alerts.md` drill 5)
and autoscaling itself (no ECS locally); those two belong to the staging checklist.

### Proposed SLOs (from the measurements above, to be confirmed on staging)

| Metric | Target | Basis |
|---|---|---|
| Interactive API (lists, details, search, dashboard) | p95 <= 300 ms at normal load; p95 <= 500 ms at 2x normal | measured 78-101 ms at 50 VUs on shared laptop cores |
| Pipeline board | p95 <= 500 ms | measured 274 ms at 50 VUs, 402 ms on the large tenant |
| Login | p95 <= 1.5 s | Argon2 cost; 460-540 ms at normal load |
| Error rate (5xx + unexpected 4xx) | < 0.5 % | 0.00 % in every stage; 429s are excluded and tracked separately |
| Export/import job (small) | completes < 10 s end to end | 2.0-2.2 s measured including polling |

"Normal load" for the SLOs means up to about 100 requests/s per api task of 1 vCPU; the ALB request-per-target
autoscaling threshold (300/min per target) should be revisited once staging measurements exist.

## 2026-09-13 (later) - deal list planner regression on the 12k-deal tenant

**Symptom.** `GET /api/v1/deals/?limit=50` on `lt-large-0` (12,000 deals) took 232 ms wall / 199 ms SQL for the
owner while the contacts list on the same tenant (25,000 rows) took 44 ms. `EXPLAIN (ANALYZE, BUFFERS)` under the
member's RLS context (`profile_endpoints --explain`) showed the planner estimating 10 rows for the whole join and
picking a nested loop driven by `pipelines_pipeline` (1 row after the RLS filter) and `pipelines_pipelinestage`
(7 rows), then walking `deal_org_pipeline_stage_idx` for **every** deal of the tenant (12,000 rows, 98,895 shared
buffers) before a top-51 sort. The ordered `(organization, created_at)` index was never considered because a sort of
"10 rows" looks free.

**Cause.** Two effects compound: the tenant predicate is applied twice (ORM filter `organization_id = X` plus the
RLS policy `organization_id = current_setting(...)`), which the planner multiplies as if independent, and the
`pipeline_id` / `stage_id` join selectivities use global distinct counts (23 tenants' pipelines) although inside one
tenant every deal belongs to its own pipeline. The INNER JOINs from `select_related("pipeline", "stage")` are what
let the planner start from the tiny RLS-filtered dimension tables.

**Fix (RLS unchanged).** `DealViewSet.base_queryset` now loads `pipeline` and `stage` with `prefetch_related`
(one small `IN (...)` query each for the page, at most a handful of distinct ids) instead of `select_related`; the
board prefetches once for all rendered cards. With only LEFT joins left, the planner starts from `deals_deal`,
uses `deal_org_created_idx` with an incremental sort and stops after 51 rows.

| Query (owner, 12k deals, best of 3, EXPLAIN ANALYZE execution time) | Before | After |
|---|---|---|
| Deal list, default sort (`-created_at`) | 197.2 ms (98,970 buffers) | 1.4 ms (337 buffers) |
| Deal list, sorted by amount | 169.3 ms | 29.5 ms (`pk IN` variant) / top-N over the org index |
| Deal list, sales rep (own scope) | 37.9 ms | 0.8 ms |

Endpoint wall time through the API (`profile_endpoints`, second run): `deals_list` 232 ms → 36 ms (SQL 199 → 15 ms);
`board` 283 ms → ~200 ms (SQL 122 → 59 ms; the remainder is serialising 300 cards, as before). Verified with
`tests/crm/test_records.py`, the deal/forecast/dashboard suites and the browser workflow.

Not changed: an alternative of running the page selection as `pk IN (ordered LIMIT subquery)` was measured at
18 ms for the default sort and 29 ms for the amount sort; it helps less than removing the joins and complicates
cursor pagination, so it was not adopted. Extended statistics (`CREATE STATISTICS ... (dependencies)`) do not apply
to join clauses and were not needed once the join order stopped being the problem.
## 2026-09-17/18 - architecture and performance audit (commit `43ef9ab`)

**Environment.** Same laptop and `docker-compose.loadtest.yml` shape as the 2026-09-13 run (nginx -> 2 x gunicorn
2 workers x 4 threads with `DB_POOL`, Next.js standalone, worker, worker-heavy, beat, PostgreSQL 16 + pgvector,
Redis 7), k6 0.54 in Docker on the same machine. 27 organisations (two of them 25,000 contacts / 12,000 deals),
192 seeded users. Before and after images were built from the same tree apart from the audit changes.

**What the numbers can and cannot say.** The k6 suite treats a 429 as an acceptable status, so a virtual user
whose login hits allauth's per-IP limit (20/min, and every VU shares one address) retries on its next iteration.
In every stage above 10 VUs the `login` row and the `throttled` total are therefore dominated by those retries,
and total requests/rps are not a capacity figure. The per-endpoint CRM rows below are real traffic. Run-to-run
variance on this machine is large at both ends of the range (the same build measured 28 ms and 82 ms for
dashboard p95 at 10 VUs, and +-20-25 % at 150 VUs), so only differences bigger than that are meaningful.

| Stage | Peak VUs | Error rate | Key p95 before -> after |
|---|---|---|---|
| baseline | 10 | 0.00 % both | dashboard 28 -> 41 ms, board 80 -> 111 ms (quiet-machine pair; an earlier pair read 82 -> 131 ms) |
| moderate | 50 | 0.00 % both | board 239 -> 207 ms, dashboard 148 -> 129 ms, contacts 130 -> 114 ms, search 143 -> 108 ms; p99 board 504 -> 282 ms |
| high | 150 | 0.00 % both | run 1: 0.83-0.96 -> 0.90-1.17 s; run 2 (back to back): 1.12-1.29 -> 0.86-1.03 s |
| spike (20 -> 100 -> 20) | 100 | 0.03 % -> 0.04 % (login 429s) | board 405 -> 392 ms, dashboard 316 -> 329 ms |
| soak (10 min) | 30 | 0.02 % both | dashboard 390 -> 104 ms, board 471 -> 200 ms, contacts 409 -> 102 ms |

Server side (peaks, 5 s samples): PostgreSQL connections 15-19 in every stage (the pool cap, as before) with at
most 3 active; Redis clients <= 41; Celery queues empty throughout; backend containers 2-9 cores and <= 527 MiB
RSS; PostgreSQL <= 1.1 cores. No 5xx in any stage.

**Reading.** The audit changed no hot-path API code, and the measurements agree: at 50 VUs and in the soak the
after run is equal or better, at 150 VUs the two pairs disagree in opposite directions, and at 10 VUs the
differences are inside the machine's own variance. Treat this as "no regression", not as an improvement; the
interactive gains from this audit are in the browser (round trips, prefetch traffic and JS per page), which this
suite does not exercise because it drives the API directly.

**Browser measurements** (Playwright against the same 25,000-contact tenant, production build, 6 loads per page
per side, interleaved before/after so machine noise hits both): server round trips per filter/sort/tab/search
change 1 -> 0; prefetch requests per list page load 23/28/19 -> 8/7/7 (pipeline/contacts/companies); deals
requests when opening the pipeline list view 2 -> 1; contacts list API calls 5 -> 4; JS transferred per page
-5 to -19 % (dashboard 302 -> 244 KB gzipped); soft navigation pipeline 346 -> 232 ms, contacts 198 -> 103 ms.
Hard-load times were unchanged within noise: the local dev server is a single Python process, so the parallel
requests the audit unblocked (deal insights now start ~117 ms earlier) contend for one GIL rather than the
several gunicorn processes production runs.
