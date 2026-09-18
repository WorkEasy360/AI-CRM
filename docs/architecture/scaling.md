# Scaling, load balancing and resilience

Status: implemented 2026-09-13 (infrastructure as Terraform in `infra/terraform/`, application changes in
this commit). Measured numbers live in [`docs/operations/load-test-results.md`](../operations/load-test-results.md).

This document is the reference for how Keel stays responsive under load, what limits are enforced where,
and which failure modes have been designed for. It does not claim unlimited capacity: the architecture is
horizontally scalable, and the verified capacity is whatever the latest load-test results record.

## 1. Production topology

```
Internet -> Route 53 -> CloudFront (WAF attached; static cached, everything else pass-through)
                            |  custom header X-Origin-Verify (secret), HTTPS only
                     Application Load Balancer  (public subnets, 2 AZs, HTTP->HTTPS redirect)
                       /api/*  /_allauth/*  -> api target group   (ECS service "api",  Django/gunicorn :8000)
                       /health/*  /admin/*  -> fixed 404
                       /*                   -> web target group   (ECS service "web",  Next.js standalone :3000)
                                               private app subnets
       worker-critical (default, notifications)   worker-heavy (imports, exports, reports)   beat (x1)
                                               private data subnets
              RDS PostgreSQL 16 Multi-AZ        ElastiCache Redis 7 (2 nodes, failover)        S3 (private)
```

Compute is ECS Fargate (ADR-0008). Fargate over an EC2 auto-scaling group because there are no hosts to
patch, every task gets its own security group and IAM role, deployments are health-checked and circuit
broken by the service scheduler, and at 2 to 6 tasks per service the price difference is small. Kubernetes
is explicitly out of scope (ADR-0008, section 43 of the brief).

Nothing except the ALB is reachable from the internet, and the ALB only accepts traffic from CloudFront's
origin-facing IP ranges carrying the origin-verify header. PostgreSQL and Redis have no public endpoints.

### Security groups (least privilege)

One security group per workload (`infra/terraform/security_groups.tf`, `local.service_profiles`).

| From | To | Port |
|---|---|---|
| CloudFront origin-facing prefix list | ALB | 443 only (no HTTP listener) |
| ALB | api tasks | 8000 |
| ALB | web tasks | 3000 |
| api, worker-critical, worker-heavy, beat, migrate | RDS (or RDS Proxy) | 5432 |
| api, worker-critical, worker-heavy, beat, migrate | ElastiCache | 6379 (TLS) |
| every task | interface VPC endpoints (ECR, Logs, Secrets Manager, CloudWatch) and the S3 gateway prefix list | 443 |
| api, web, worker-critical, worker-heavy | internet via NAT (LLM, OAuth, WhatsApp, embeddings; web reaches the app domain through CloudFront) | TCP 443 only |
| worker-critical | internet via NAT (`EMAIL_URL` SMTP submission) | TCP 587 only |
| beat, migrate | internet | none |

## 2. Stateless application tier

Any request can reach any healthy Django task; no sticky sessions.

| State | Where it lives | Notes |
|---|---|---|
| Sessions | PostgreSQL (`cached_db`), Redis as read cache | A Redis outage degrades to database reads (`CACHE_FAIL_OPEN`). |
| Cache | Redis | Every key has a TTL; keys are tenant-scoped (section 6). |
| CSRF | Cookie (double submit) | Stateless. |
| Import uploads, export files | S3 private bucket (`PRIVATE_STORAGE_BACKEND=s3`) | Filesystem backend is refused by production settings. |
| Background work | Redis broker, Celery queues | `acks_late` + `reject_on_worker_lost`; every task idempotent. |
| Tenant context | ContextVar per request/task; `SET LOCAL` in the DB transaction | Thread-safe and pooler-safe. |

The frontend is a Next.js standalone server: no local state, no server-side data fetching for CRM data
(pages are client shells that call the API), a per-request CSP nonce, `Cache-Control: no-store` on pages.

## 3. Health checks and graceful deployment

| Probe | Path | Used by | Behaviour |
|---|---|---|---|
| Django liveness | `GET /health/live/` | container health check | process answers; no dependencies |
| Django readiness | `GET /health/ready/` | ALB target group | 200 when PostgreSQL answers `SELECT 1`; Redis failure is logged but non-fatal (the app degrades) |
| Next.js | `GET /health` | container + ALB | route handler, no rendering |

Probes arrive over plain HTTP with the task IP as `Host`; `HealthProbeMiddleware` normalises the host for
exactly those paths so `ALLOWED_HOSTS` and the HTTPS redirect do not mark every target unhealthy. Forwarded
(public) requests to the readiness path get a shallow answer and the ALB returns 404 for `/health/*`, so the
probe cannot be used to hammer the database. Bodies are always `{"status": "ok" | "unavailable"}`.

Rollout: new task starts -> container health check passes -> ALB health check passes (2 x 15 s) -> traffic
-> old task deregisters (30 s drain) -> SIGTERM -> gunicorn `graceful_timeout` (30 s) finishes in-flight
requests -> exit. Services deploy with minimum healthy 100 % / maximum 200 % and a circuit breaker that rolls
back automatically; `beat` deploys stop-then-start so two schedulers never overlap. Workers get a 120 s stop
timeout so a running import finishes or is redelivered cleanly.

Migrations: the deploy pipeline runs a one-off `migrate` task before rolling services. Only additive
(expand) migrations may ship with a rollout; column removals and renames are a later "contract" deploy after
every task runs the new code (`docs/architecture/database-design.md`, ADR-0007 style versioning applies).

## 4. Django runtime (gunicorn)

`backend/config/gunicorn.py`, environment-driven, no CPU formula:

| Setting | Default | Why |
|---|---|---|
| worker class | `gthread` | requests wait on PostgreSQL/Redis; threads add concurrency without process memory |
| `GUNICORN_WORKERS` x `GUNICORN_THREADS` | 2 x 4 per 1 vCPU / 2 GB task | measured; raise threads before workers |
| `timeout` | 30 s | heartbeat guard for a wedged worker |
| `graceful_timeout` | 30 s | drain on SIGTERM |
| `keepalive` | 75 s | must exceed ALB idle timeout (60 s) to avoid 502s on reused connections |
| request line / header limits | 8190 / 100 fields | reject malformed requests before Django |
| `max_requests` | off | enable only when memory growth is observed |
| `preload_app` | on | fork after import; connections closed in `post_fork` |

## 5. Database connections

Per process: psycopg's pool (`DB_POOL=true`), `max_size = GUNICORN_THREADS`, `timeout = 5 s` (a thread
that cannot get a connection fails fast instead of queueing forever). Per task: `GUNICORN_WORKERS x
DB_POOL_MAX_SIZE` = 8. Celery workers: one connection per concurrency slot.

Connection budget with the Terraform defaults:

| Service | Max tasks | Connections each | Max total |
|---|---|---|---|
| api | 6 | 8 | 48 |
| worker-critical | 4 | 4 | 16 |
| worker-heavy | 3 | 2 | 6 |
| beat, migrate | 1 | 1 | 2 |
| **Total** | | | **72** |

`db.t4g.medium` allows roughly 400 connections, so the budget is under 20 % even at maximum scale-out,
and the `DatabaseConnections` alarm fires at 80 % of `db_max_connections_alarm`. RDS Proxy is available
behind `enable_rds_proxy` (Terraform) and the application is already proxy-safe (`SET LOCAL` context, no
named prepared statements: `prepare_threshold = None`). Enable it when the budget passes about 60 % of the
instance's `max_connections`, or when autoscaling events show connection storms. PgBouncer was not chosen:
it would be one more container to run and patch for the same transaction-mode behaviour.

Server-side timeouts on every connection: `statement_timeout` 15 s, `lock_timeout` 5 s,
`idle_in_transaction_session_timeout` 60 s, `connect_timeout` 5 s. RDS parameters: `rds.force_ssl`,
`log_min_duration_statement = 500 ms`, `pg_stat_statements`, Performance Insights.

## 6. Redis

ElastiCache Redis 7, two nodes with automatic failover, TLS and AUTH, `maxmemory-policy = volatile-lru`
(Celery broker keys carry no TTL and must never be evicted; cache keys all carry TTLs). Application side:
2 s connect/read timeouts, 20 connections per process, `retry_on_timeout`.

Uses: session read cache, dashboard cache, DRF/allauth throttle counters, email idempotency markers, Celery
broker (database 1). No CRM data is stored only in Redis.

`CACHE_FAIL_OPEN=true` in production: when Redis is unreachable, reads return `None` and writes are dropped
(logged), so login and browsing continue against PostgreSQL. Accepted trade-off: DRF and allauth throttles
cannot count during the outage; the WAF rate rules remain as the outer limit and the `Redis` alarms page
the on-call.

### Cache key security

Tenant-owned cache entries embed the organization and, where permissions shape the output, the member and
their permission scope. Dashboard keys:

```
keel:dash:{org_id}:v{org_version}:{membership_id}:{sha256(role, grants, team-mates)[:24]}:{period}:{pipeline}
```

`org_version` is bumped by every CRM write in the organization (create, update, archive, restore, bulk,
stage move, import), so a write invalidates all dashboard entries of that organization at once; the 60 s TTL
bounds staleness if a bump is lost. A role or team change changes the fingerprint, so an entry computed with
wider rights is never served after rights were narrowed. Tests: `backend/tests/scaling/test_cache_isolation.py`
(Org A cache vs Org B request, own-scope vs all-scope, invalidation, cache outage).

## 7. Celery

| Queue | Consumer service | Concurrency | Tasks | Limits |
|---|---|---|---|---|
| default | worker-critical | 4 | metrics, purge, stale-job sweep | 600 s hard |
| notifications | worker-critical | 4 | `accounts.send_email` | 45 s hard, 3 retries with backoff+jitter |
| imports | worker-heavy | 2 | `importexport.run_import` | 3600 s hard |
| exports | worker-heavy | 2 | `importexport.run_export` | 1800 s hard |
| reports | worker-heavy | 2 | (reserved) | |
| integrations | worker-heavy | 2 | `integrations.*`, mailbox sync (`messaging.sync_email_account*`, expires after 270 s) | per task |
| ai | none yet | | (Phase 5) | |

A stuck import can therefore only occupy a heavy slot; emails and metrics keep flowing, and the API never
waits on any of them. `visibility_timeout` (2 h) exceeds every task limit so Redis never redelivers a
running job. Idempotency: jobs are claimed by status (`pending` -> `running`), emails carry a message id
with a sent marker, the metrics task is read-only.

Tenant safety: every job task is a `tenant_task` that binds the organization from the stored job and
rebuilds the requester's actor from their membership id; a job id from another organization is simply not
found (`tests/scaling/test_background_jobs.py`). Fairness: `MAX_ACTIVE_JOBS_PER_ORG` (3) pending or running
jobs per organization; the fourth request gets `429 too_many_active_jobs`. A job whose enqueue was lost after
COMMIT (broker blip) or whose worker died never leaves `pending`; `importexport.fail_stale_jobs` (beat, every
15 min) fails jobs older than 4 h (visibility timeout + longest hard limit), skipping rows a worker holds, so
they stop occupying quota slots. The enqueue itself is best effort and never turns an accepted job into a 500.

Autoscaling signals: `Keel/QueueDepth` and `Keel/OldestMessageAgeSeconds` per queue, published every 30 s
by `observability.publish_celery_metrics` (beat) from the broker directly; `TaskFailures` from the failure
signal. Workers scale on depth and age, never on CPU alone (section 9).

## 8. Storage (S3)

Private bucket, block public access, SSE-KMS, TLS-only bucket policy, no public URLs. Keys are
`{org_id}/{imports|exports|email|files}/{32 hex}.{csv|bin}`, generated server-side and validated on every
read. Only import uploads and export results expire (7 days): they are written with the object tag
`retention=temporary` and the lifecycle rule matches that tag. Email attachments and record files share the
bucket and are permanent; because keys start with the organization id, a prefix rule cannot separate them. Downloads: the API authorises and audits, then answers `302` to a signed URL that expires in 60 s and
forces `Content-Disposition: attachment`; bytes never pass through a Django thread. Expired export files are
purged by beat (`importexport.purge_expired`) with the lifecycle rule as backstop.

## 9. Autoscaling

| Service | Min / max | Scale-out signal | Scale-in |
|---|---|---|---|
| api | 2 / 6 | ALB requests per target > 300 or CPU > 60 % (target tracking, 60 s cooldown) | 300 s cooldown |
| web | 2 / 4 | requests per target > 500 or CPU > 60 % | 300 s cooldown |
| worker-critical | 1 / 4 | QueueDepth(default) >= 20 (+1), >= 100 (+2), OldestMessageAge >= 120 s (+1) | depth 0 for 10 min (-1) |
| worker-heavy | 1 / 3 | sum QueueDepth(imports, exports, reports) same steps | same |
| beat | 1 / 1 | never | never |

Maximums are hard caps: a spike can never create unbounded tasks or database connections. The request-per-
target values are starting points from the local baseline and must be re-tuned from CloudWatch after the
first production week.

## 10. Rate limiting and request limits

| Layer | Limit |
|---|---|
| WAF | 100 login requests / 5 min / IP on `/_allauth/browser/v1/auth/*`; 1500 API requests / 5 min / IP; 3000 requests / 5 min / IP; managed rule sets (common, known bad inputs, IP reputation, SQLi) |
| ALB | idle timeout 60 s, invalid header fields dropped |
| gunicorn | request line 8190 B, 100 header fields |
| Django | body 1 MB (JSON), upload 5 MB CSV / 10k rows / 60 columns; page size 50 (max 200); bulk ids 500; search 200 chars, 8 terms, 20 results per type; export 100k rows; dashboard periods 7d/30d/90d/365d only |
| DRF throttles (per real client IP or user) | anon 60/min, user 600/min, auth 10/min, sensitive (imports, exports, session switches) 30/min, search + dashboard 120/min, admin 120/min |
| allauth | login 20/min/IP, failed logins 10/min/IP and 10/15min/account, signup 10/min/IP, reset 20/min/IP |
| per organization | 3 active import/export jobs; list counts stop at 10,000 |

The real client address comes from `ClientIPMiddleware` (`TRUSTED_PROXY_COUNT` hops from the right of
`X-Forwarded-For`, 2 for CloudFront + ALB) and DRF is pinned to `NUM_PROXIES = 0`, so throttle buckets cannot
be spoofed with a forged header.

## 11. Timeouts (no request hangs forever)

| Hop | Timeout |
|---|---|
| Browser fetch | none by default; UI shows errors from the API problem details |
| CloudFront -> ALB | origin read 60 s, keepalive 5 s |
| ALB | idle 60 s |
| gunicorn | keepalive 75 s, worker heartbeat 30 s |
| PostgreSQL | statement 15 s, lock 5 s, idle-in-transaction 60 s, connect 5 s, pool wait 5 s |
| Redis (cache) | connect 2 s, socket 2 s |
| Redis (broker) | connect 5 s, socket 30 s |
| S3 / CloudWatch | connect 3 s / 2 s, read 30 s / 5 s; CloudWatch calls from request threads run on a background thread |
| AI provider (request thread) | `AI_INTERACTIVE_DEADLINE_SECONDS` (40 s) for the whole primary + fallback chain, no SDK retries; at most `AI_MAX_CONCURRENT_CALLS_PER_PROCESS` calls wait per process, the rest degrade at once |
| Celery | soft/hard limits per queue (section 7) |
| SMTP (from the worker only) | task hard limit 45 s |

## 12. Observability

Structured JSON logs (request id, ALB trace id, user, organization, duration, status; never bodies,
headers, cookies or secrets) to CloudWatch Logs with 30-day retention (security group 365 days). Requests
over `SLOW_REQUEST_MS` (1 s) log at WARNING. Metrics: ALB (request count, p50/p95/p99 target response
time, 4xx, 5xx, unhealthy hosts), ECS (CPU, memory), RDS (CPU, connections, latency, storage, Performance
Insights, slow-query log), ElastiCache (memory, connections, evictions, CPU), custom `Keel/*` (queue depth,
oldest message age, task failures), WAF (blocked requests), autoscaling activity. Alarms and thresholds:
[`docs/operations/alerts.md`](../operations/alerts.md).

## 13. Failure isolation and expected failure behaviour

| Failure | Behaviour |
|---|---|
| One api/web task dies | ALB stops routing after 3 failed checks (45 s); ECS replaces it; in-flight requests on that task fail once, the rest are unaffected |
| One worker dies mid-import | message redelivered after visibility timeout to another worker; job restarts from `pending` only if it was never claimed, otherwise it fails with a clear error |
| Redis unavailable | login and browsing continue (database sessions), dashboard recomputes, throttles fail open behind WAF, Celery workers reconnect indefinitely, queue producers fail the request with a 5xx for job submission only |
| Database connection saturation | pool wait times out in 5 s -> 5xx for that request, no thread pile-up; `DatabaseConnections` alarm |
| Slow query | `statement_timeout` 15 s -> error for that request; logged by RDS slow-query log |
| Heavy report/export job | runs on worker-heavy only; API and critical queue unaffected |
| AI provider slow or down | bounded by the 40 s deadline and the per-process bulkhead: the assistant answers from the CRM, drafting answers 503, contacts/deals/pipeline keep their request threads; the circuit breaker skips the provider after repeated failures |
| Mail provider down | emails retry with backoff on the notifications queue; signup/login/invite requests are not delayed |
| Availability zone loss | ALB, tasks, RDS standby and Redis replica span two AZs |

## 14. Cost drivers and trade-offs

Rough on-demand estimate for the defaults in `ap-south-1` is about USD 600/month (table in
`infra/terraform/README.md`): NAT gateway, VPC endpoints, Multi-AZ RDS and two Redis nodes are the large fixed
items. Cheaper options that reduce availability are documented there (single Redis node, no VPC endpoints)
and are not the defaults. Scaling caps, log retention, S3 lifecycle and ECR retention prevent runaway spend.

## 15. Local reproduction

`docker-compose.loadtest.yml` runs the same shape on a laptop: nginx with the ALB path rules in front of two
gunicorn instances, split workers, beat and the Next.js standalone image; `loadtest/` holds the k6 suite.
