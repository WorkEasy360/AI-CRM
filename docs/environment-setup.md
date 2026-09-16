# Environment Setup

## Prerequisites
- Docker (Desktop or Engine) for PostgreSQL 16, Redis 7 and Mailpit
- `uv` ≥ 0.11 (installs Python 3.13 automatically)
- Node 20+ with `corepack enable pnpm` (pnpm 10)

## First run
```bash
cp .env.example .env                      # local-only values; never commit .env
docker compose up -d --wait postgres redis mailpit   # --wait blocks until the health checks pass
cd backend
uv sync                                   # creates .venv from uv.lock
uv run python manage.py migrate
uv run python manage.py rls_check         # must print "RLS check passed"
uv run python manage.py runserver 8000
```
In another terminal:
```bash
cd frontend
pnpm install
pnpm dev                                  # http://localhost:3000, proxies /api and /_allauth to :8000
```
Background worker (CSV imports and exports are processed by Celery; without it jobs stay `pending`):
```bash
cd backend
uv run celery -A config.celery worker -l info -Q default     # or: make worker
```
Import uploads and export files are written under `backend/private/` (git-ignored; `PRIVATE_STORAGE_ROOT`
overrides the location) and are only reachable through the authenticated download endpoint.

Mailpit UI: http://localhost:8025 (verification, invitation and reset emails land here).

PostgreSQL is published on host port **5433** (5432 is often taken locally). The image is
`pgvector/pgvector:pg16` — stock PostgreSQL 16 plus the `vector` extension that the Ask Keel knowledge
index needs. The init scripts create the `crm_app` role as **non-superuser without RLS bypass** (so Row
Level Security is exercised in dev and tests) and install `vector` into `template1` and `keel`, which
means Django's `test_keel` inherits it and migrations only have to run `CREATE EXTENSION IF NOT EXISTS
vector` as a no-op.

### Coming from the old `postgres:16-alpine` image
The data volume carries over unchanged (same major version), but the collation provider differs
(musl -> glibc), so reindex once after the switch:

```bash
docker compose up -d --wait postgres
docker exec keel-postgres-1 psql -U postgres -d template1 -c "CREATE EXTENSION IF NOT EXISTS vector;"
docker exec keel-postgres-1 psql -U postgres -d keel     -c "CREATE EXTENSION IF NOT EXISTS vector;"
docker exec keel-postgres-1 psql -U postgres -d keel     -c "REINDEX DATABASE keel; REINDEX SYSTEM keel;"
docker exec keel-postgres-1 psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS test_keel;"
```

## Ask Keel: embeddings and the knowledge index
The assistant answers structured questions with SQL and unstructured ones from a pgvector index over
notes, emails, WhatsApp messages, meeting and call write-ups and deal descriptions.

Embeddings default to `RAG_EMBEDDING_BACKEND=local`: deterministic, offline, free, and **lexical rather
than semantic** — it finds the wording, not the meaning. That makes a fresh checkout work with no
credentials and no bill. For semantic recall, set `RAG_EMBEDDING_BACKEND=voyage` with `VOYAGE_API_KEY`
(or `openai` with `OPENAI_API_KEY`) and rebuild the index; Anthropic publishes no embeddings API, which
is why the reasoning provider and the embedding provider are configured separately.

Indexing runs on its own `rag_indexing` Celery queue (`make worker-heavy`), driven by a transactional
outbox, so a CRM write is never delayed by an embedding call and an embedding failure never affects CRM
data. To build or rebuild:

```bash
make rag-index                                              # every workspace, queued
cd backend && uv run python manage.py rebuild_rag_index --organization <uuid> --inline   # no worker needed
```

The command is tenant-scoped, batched, resume-safe and idempotent: sources whose content hash is
unchanged are skipped without an embedding call, so re-running it costs queries, not money.

## `connection timeout expired ... port 5433`

That error means nothing is listening on 5433 — the Postgres container is not running, almost always
because the Docker engine was stopped or the machine rebooted. Two things prevent it:

- `postgres`, `redis` and `mailpit` declare `restart: unless-stopped`, so they come back on their own
  as soon as the Docker engine starts. Containers stopped deliberately with `docker compose down` or
  `docker stop` stay stopped, as intended.
- On Windows, start the backend with `pwsh -File scripts/dev.ps1` (add `-Port 8001` to use another
  port). It launches Docker Desktop if the engine is down, waits for the Postgres health check, then
  runs `migrate` and `runserver`. `scripts/ensure-services.ps1` does the dependency half alone and is
  safe to run when everything is already up.

If Docker Desktop itself is not running and you are not using the script, start it from
`%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe` (it is a per-user install on Windows, so
it is not under `Program Files`), then re-run `docker compose up -d --wait postgres redis mailpit`.

## Tests and checks
```bash
cd backend
uv run pytest                              # 123 tests incl. tenant isolation, authz matrix, security regression
uv run ruff check . && uv run ruff format --check .
uv run mypy .
uv run bandit -c pyproject.toml -r apps config security -q
uv run pip-audit
```
Semgrep and gitleaks have no native Windows builds; run them through Docker:
```bash
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo" zricethezav/gitleaks:latest \
  detect --source /repo --config /repo/.gitleaks.toml --no-banner --no-git --exit-code 1
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W)/backend:/src" -v "$(pwd -W)/security/semgrep:/rules" \
  semgrep/semgrep:latest semgrep scan --config p/django --config p/python --config /rules/keel.yml \
  --metrics=off --exclude=.venv --exclude=migrations --error /src
```

## Settings modules
| Module | Use |
|---|---|
| `config.settings.dev` | local development (`DEBUG` on, insecure cookies, headless API spec served) |
| `config.settings.test` | pytest (adds `tests.testapp`, locmem cache/email, eager Celery, generous throttles) |
| `config.settings.prod` | staging/production; refuses to start unless `ENVIRONMENT`, `ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS` and a strong `SECRET_KEY` are set |

## Production database roles
Run `infra/postgres/prod-roles.sql` once as a DBA, migrate as `crm_migrator`, then run
`manage.py grant_app_role` so `crm_app` receives DML grants and loses UPDATE/DELETE on append-only tables.
The application must always connect as `crm_app`.

## Regenerating the API schema for the frontend
```bash
cd backend && uv run python manage.py spectacular --file ../frontend/openapi.json --format openapi-json
cd ../frontend && pnpm gen:api
```
