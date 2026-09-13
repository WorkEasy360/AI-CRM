# Alerts and first-response runbook

All alarms are defined in `infra/terraform/alarms.tf` and notify the SNS topic (`alarm_email`). Thresholds are
deliberately conservative first values; tune them from the first weeks of production data and record changes
here.

| Alarm | Threshold (initial) | First response |
|---|---|---|
| ALB 5xx rate | > 2 % of requests over 5 min | Check api task health and recent deploy; `RequestLoggingMiddleware` lines with `status>=500` carry the request id; roll back with the previous task definition if it started with a deploy |
| ALB p95 target response time | > 1.0 s for 3 consecutive minutes (per target group) | Compare with RDS CPU / connections and Redis; look for `http.slow_request` warnings; scale api out manually if autoscaling lags |
| Unhealthy targets | >= 1 for 2 min | `aws ecs describe-tasks`; container logs for the failing readiness probe (`health.database_unavailable`) |
| ECS CPU / memory | > 85 % (5 min) per service | Confirm autoscaling is at max; consider raising task size before max count |
| RDS CPU | > 80 % for 10 min | Performance Insights top SQL; slow-query log (`log_min_duration_statement=500`); check for a runaway export/import |
| RDS connections | > 80 % of `db_max_connections_alarm` | Verify task counts x pool sizes; enable RDS Proxy (`enable_rds_proxy=true`) if the budget is legitimately exceeded |
| RDS free storage / memory | < 10 GiB / < 256 MiB | Storage autoscaling should already be raising the limit; investigate growth (audit events, stage history) |
| RDS read latency | > 20 ms | Usually IO-bound scans; check missing indexes with `profile_endpoints` on staging |
| Redis memory | > 80 % | Look for keys without TTL (`redis-cli --bigkeys`); the broker queues should be near empty |
| Redis evictions | > 0 | Memory pressure; `volatile-lru` only evicts TTL keys, so the broker is safe, but cache hit rate drops |
| Redis connections | > 5000 | A connection leak in a task; restart the offending service |
| Celery queue depth | > 500 for 10 min (per queue) | Check worker service health and `TaskFailures`; scale worker-heavy manually; look for one tenant flooding (job quota) |
| Celery oldest message age | > 600 s for 5 min | Workers stuck or missing; restart the worker service |
| Task failures | > 5 in 5 min | Worker logs (`celery.task_failed` with task and queue) |
| WAF blocked requests | > 1000 in 5 min | Inspect sampled requests; an attack in progress or a false positive on a managed rule |
| Login failures (log metric) | > 200 in 5 min | Credential stuffing; confirm WAF login rule is blocking; consider tightening `login_failed` rate |
| Rate limited (log metric `status=429`) | > 500 in 5 min | A client loop or abuse; identify user/IP from logs |

## Expected failure drills

Run these on staging after each significant change; expected outcomes are in
[`docs/architecture/scaling.md`](../architecture/scaling.md), section 13.

1. Stop one api task (`aws ecs stop-task`) while a load test runs: error blip < 1 % for < 60 s, no session loss.
2. Stop one web task: same.
3. Restart worker-heavy during an import: the job finishes or fails with `error_message`, nothing is duplicated.
4. Reboot the Redis primary (failover): requests keep succeeding; `health.cache_unavailable` warnings for a few seconds.
5. Saturate the pool (`DB_POOL_MAX_SIZE=1` on one task): that task answers 5xx quickly instead of hanging; the ALB keeps routing to healthy tasks.
6. Submit a 100k-row export while browsing: API latency unchanged; heavy queue depth rises and falls.
