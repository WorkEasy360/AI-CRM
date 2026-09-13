#!/usr/bin/env bash
# Sample server-side metrics every INTERVAL seconds (default 5) until killed (Ctrl-C).
#
#   ./collect_metrics.sh            # writes loadtest/results/metrics-<timestamp>.csv
#   INTERVAL=2 ./collect_metrics.sh
#
# Rows are "long" format so a variable number of containers fits one schema:
#   timestamp,source,metric,value
#   2026-01-01T12:00:00Z,docker:keel-backend-1,cpu_percent,42.17
#   2026-01-01T12:00:00Z,docker:keel-backend-1,mem_usage,512.3MiB
#   2026-01-01T12:00:00Z,postgres,connections_total,14
#   2026-01-01T12:00:00Z,postgres,connections_active,3
#   2026-01-01T12:00:00Z,redis,used_memory_human,2.10M
#   2026-01-01T12:00:00Z,redis,connected_clients,9
#   2026-01-01T12:00:00Z,celery,queue_default,0
#
# Pivot in a spreadsheet / pandas: df.pivot_table(index="timestamp", columns=["source","metric"], values="value").
set -uo pipefail

INTERVAL="${INTERVAL:-5}"
PG_CONTAINER="${PG_CONTAINER:-keel-postgres-1}"
REDIS_CONTAINER="${REDIS_CONTAINER:-keel-redis-1}"
CONTAINER_PREFIX="${CONTAINER_PREFIX:-keel-}"
DB_NAME="${DB_NAME:-keel}"
DB_USER="${DB_USER:-postgres}"
BROKER_DB="${BROKER_DB:-1}"   # CELERY_BROKER_URL is redis://redis:6379/1
QUEUES="${QUEUES:-default imports exports notifications reports}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$DIR/results"
OUT="$DIR/results/metrics-$(date -u +%Y%m%dT%H%M%SZ).csv"
export MSYS_NO_PATHCONV=1

echo "timestamp,source,metric,value" > "$OUT"
echo "sampling every ${INTERVAL}s into $OUT (Ctrl-C to stop)"
trap 'echo; echo "stopped: $OUT"; exit 0' INT TERM

while true; do
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  {
    # Container CPU / memory (docker stats --no-stream takes ~1-2 s itself).
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' 2>/dev/null \
      | grep "^${CONTAINER_PREFIX}" \
      | while IFS=, read -r name cpu mem; do
          echo "$now,docker:$name,cpu_percent,${cpu%\%}"
          echo "$now,docker:$name,mem_usage,${mem%% /*}"
        done

    # Postgres connections (total / active) for the application database.
    pg="$(docker exec "$PG_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
      "select count(*), count(*) filter (where state='active') from pg_stat_activity where datname='${DB_NAME}'" 2>/dev/null | tr -d '[:space:]')"
    if [ -n "$pg" ]; then
      echo "$now,postgres,connections_total,${pg%%|*}"
      echo "$now,postgres,connections_active,${pg##*|}"
    else
      echo "$now,postgres,connections_total,"
    fi

    # Redis memory and clients.
    mem="$(docker exec "$REDIS_CONTAINER" redis-cli info memory 2>/dev/null | grep '^used_memory_human:' | cut -d: -f2 | tr -d '[:space:]')"
    clients="$(docker exec "$REDIS_CONTAINER" redis-cli info clients 2>/dev/null | grep '^connected_clients:' | cut -d: -f2 | tr -d '[:space:]')"
    echo "$now,redis,used_memory_human,${mem}"
    echo "$now,redis,connected_clients,${clients}"

    # Celery queue depths on the broker database.
    for q in $QUEUES; do
      depth="$(docker exec "$REDIS_CONTAINER" redis-cli -n "$BROKER_DB" llen "$q" 2>/dev/null | tr -d '[:space:]')"
      echo "$now,celery,queue_${q},${depth}"
    done
  } >> "$OUT"
  sleep "$INTERVAL"
done
