#!/usr/bin/env bash
# Run one load-test stage through Docker (grafana/k6). Works in Git Bash on Windows and on Linux/macOS.
#
#   ./run.sh <stage> [BASE_URL]
#
#   stage     baseline | moderate | high | spike | soak | e | g | h
#   BASE_URL  origin the k6 container should hit (default http://host.docker.internal:8000 = Django directly;
#             use http://host.docker.internal:3000 to go through Next.js)
#
# Environment pass-through: SESSION_COOKIE, CSRF_COOKIE, SOAK_MINUTES, plus the optional tuning knobs
# listed in README.md (E_VUS, G_IO_VUS, H_REPORT_VUS, VERBOSE, ...). Extra k6 flags go in K6_ARGS,
# e.g. K6_ARGS="--http-debug=full" ./run.sh baseline
set -euo pipefail

usage() {
  echo "usage: $0 <smoke|baseline|moderate|high|spike|soak|e|g|h> [BASE_URL]" >&2
  exit 1
}

STAGE="${1:-}"
[ -n "$STAGE" ] || usage
BASE_URL="${2:-${BASE_URL:-http://host.docker.internal:8000}}"
K6_IMAGE="${K6_IMAGE:-grafana/k6:0.54.0}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Docker on Windows wants C:/... paths; `pwd -W` exists only in MSYS/Git Bash.
HOST_DIR="$(cd "$DIR" && (pwd -W 2>/dev/null || pwd))"

if [ ! -f "$DIR/users.json" ]; then
  echo "loadtest/users.json is missing. Seed it first:" >&2
  echo "  cd backend && uv run python manage.py seed_loadtest --out ../loadtest/users.json" >&2
  exit 1
fi
mkdir -p "$DIR/results"

ENV_ARGS=(
  -e "STAGE=$STAGE"
  -e "BASE_URL=$BASE_URL"
  -e "SESSION_COOKIE=${SESSION_COOKIE:-keel_session}"
  -e "CSRF_COOKIE=${CSRF_COOKIE:-keel_csrftoken}"
  -e "SOAK_MINUTES=${SOAK_MINUTES:-30}"
)
for name in E_VUS E_MINUTES G_IO_VUS G_BROWSE_VUS G_MINUTES H_REPORT_VUS H_PIPELINE_VUS H_MINUTES \
            VERBOSE SEARCH_PREFIXES IMPORT_ROWS JOB_POLL_SECONDS JOB_POLL_MAX_SECONDS IO_MIN_ITERATION_SECONDS \
            RECENT_AUTH_MINUTES; do
  if [ -n "${!name:-}" ]; then
    ENV_ARGS+=(-e "$name=${!name}")
  fi
done

# On Linux the bind mount keeps the host uid; run k6 as that uid so /results is writable.
USER_ARGS=()
if [ "$(uname -s)" = "Linux" ]; then
  USER_ARGS=(--user "$(id -u):$(id -g)")
fi

echo "k6 stage=$STAGE base=$BASE_URL image=$K6_IMAGE results=$HOST_DIR/results"
# shellcheck disable=SC2086
MSYS_NO_PATHCONV=1 docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  "${USER_ARGS[@]}" \
  -v "$HOST_DIR/k6:/scripts" \
  -v "$HOST_DIR/results:/results" \
  -v "$HOST_DIR/users.json:/scripts/users.json:ro" \
  "${ENV_ARGS[@]}" \
  "$K6_IMAGE" run ${K6_ARGS:-} "$([ "$STAGE" = smoke ] && echo /scripts/smoke.js || echo /scripts/main.js)"
