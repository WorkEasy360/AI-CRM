#!/usr/bin/env bash
# Expected-failure drills against the local load-test stack while a k6 stage runs in another terminal.
#
#   ./resilience.sh backend     # stop backend-b for 45 s, then start it (ALB/nginx must route around it)
#   ./resilience.sh frontend    # same for the Next.js container
#   ./resilience.sh worker      # restart worker-heavy mid-run (imports/exports must resume or fail cleanly)
#   ./resilience.sh redis       # pause Redis for 20 s (login/browsing must continue, throttles fail open)
#   ./resilience.sh all         # run the four drills back to back with pauses between them
#
# Each drill logs timestamps so the k6 results and metrics CSV can be correlated. Nothing here touches
# production: it only drives docker compose services named keel-*.
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.loadtest.yml --profile full --profile loadtest)
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }

drill_backend() {
  echo "$(stamp) DRILL backend: stopping backend-b"
  "${COMPOSE[@]}" stop backend-b >/dev/null
  sleep 45
  echo "$(stamp) DRILL backend: starting backend-b"
  "${COMPOSE[@]}" start backend-b >/dev/null
  # nginx resolved the container IP at start-up; production ALBs register targets dynamically instead.
  sleep 10
  "${COMPOSE[@]}" restart lb >/dev/null
  echo "$(stamp) DRILL backend: done"
}

drill_frontend() {
  echo "$(stamp) DRILL frontend: stopping frontend"
  "${COMPOSE[@]}" stop frontend >/dev/null
  sleep 30
  "${COMPOSE[@]}" start frontend >/dev/null
  sleep 5
  "${COMPOSE[@]}" restart lb >/dev/null
  echo "$(stamp) DRILL frontend: done"
}

drill_worker() {
  echo "$(stamp) DRILL worker: restarting worker-heavy"
  "${COMPOSE[@]}" restart worker-heavy >/dev/null
  echo "$(stamp) DRILL worker: done"
}

drill_redis() {
  echo "$(stamp) DRILL redis: pausing redis for 20 s"
  docker pause keel-redis-1 >/dev/null
  sleep 20
  docker unpause keel-redis-1 >/dev/null
  echo "$(stamp) DRILL redis: done"
}

case "${1:-}" in
  backend) drill_backend ;;
  frontend) drill_frontend ;;
  worker) drill_worker ;;
  redis) drill_redis ;;
  all)
    drill_backend; sleep 30
    drill_worker; sleep 30
    drill_redis; sleep 30
    drill_frontend
    ;;
  *) echo "usage: $0 backend|frontend|worker|redis|all" >&2; exit 2 ;;
esac
