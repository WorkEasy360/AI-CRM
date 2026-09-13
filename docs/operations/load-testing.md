# Load testing

Tooling: **k6** (`loadtest/`), chosen over Locust because it is a single static binary that runs from Docker
with no Python worker fleet, has first-class scenario executors (constant, ramping, spikes with `startTime`),
built-in thresholds and per-endpoint tagging, and a low per-VU footprint so a laptop can drive 150+ VUs.
Scripts, scenarios and the runner are documented in [`loadtest/README.md`](../../loadtest/README.md).

## Environment under test (local)

`docker-compose.loadtest.yml` reproduces the production shape on one machine:

- nginx (`infra/nginx/loadtest.conf`) with the ALB path rules, round-robin over two gunicorn instances
  (`backend-a`, `backend-b`; 2 workers x 4 threads each, `DB_POOL=true`, `CACHE_FAIL_OPEN=true`,
  `TRUSTED_PROXY_COUNT=1`, `EXPOSE_INSTANCE_HEADER=true`)
- Next.js standalone image, `worker` (default, notifications), `worker-heavy` (imports, exports, reports), `beat`
- PostgreSQL 16 and Redis 7 containers

Seed: `make seed-loadtest` creates 5 small tenants (300 contacts, 100 companies, 200 deals each) and one
large tenant (25,000 contacts, 5,000 companies, 12,000 deals, 500 products) with 5 users each and writes
`loadtest/users.json`. It refuses to run with `ENVIRONMENT=production|staging`.

```
docker compose -f docker-compose.yml -f docker-compose.loadtest.yml --profile full --profile loadtest up -d --build
cd loadtest && ./collect_metrics.sh &        # docker stats, pg_stat_activity, redis, queue depths every 5 s
./run.sh baseline http://host.docker.internal:8080   # then moderate, high, spike, soak, e, g, h
```

Query profiling before a run: `python manage.py profile_endpoints --email owner@lt-large-0.example.com --explain 3`
prints SQL count, SQL time and wall time per hot endpoint and `EXPLAIN ANALYZE` for the slowest statements
(run inside the member's tenant context so RLS plans are real).

## Stages

| Stage | Shape | Purpose |
|---|---|---|
| baseline | 10 VUs, 2 min | reference numbers, sanity |
| moderate | ramp to 50 VUs, hold 4 min | normal business load |
| high | ramp to 150 VUs, hold 5 min | saturation search |
| spike | 20 VUs -> 100 VUs instantly -> 20 VUs | autoscaling / recovery behaviour |
| soak | 30 VUs, 30+ min | leaks and drift |
| e / g / h | large tenant / import-export under browsing / report + pipeline | isolation scenarios |

Mixed stages run scenarios A-F by weight (browse 50 %, move deal 15 %, search 15 %, dashboard-heavy 10 %,
multi-tenant 10 %). Every VU logs in once (Argon2), then paces itself under the per-user throttles; 429s are
counted separately (`throttled`) and never hidden inside the error rate.

## Reading results

`loadtest/results/<stage>-<timestamp>.txt` has the per-endpoint table (count, rps, p50/p95/p99, errors) and
threshold verdicts; `.json` has the raw k6 summary; `metrics-<timestamp>.csv` has the server-side samples.
Record the numbers in [`load-test-results.md`](load-test-results.md) with the commit hash and the
environment description; never report a number that was not measured.

## Against AWS

The `Load test` GitHub Actions workflow (`workflow_dispatch`) runs any stage against a staging URL using the
production cookie names, with `loadtest/users.json` supplied from a repository secret. It refuses URLs that
look like production. Seeded tenants must never exist in production.
