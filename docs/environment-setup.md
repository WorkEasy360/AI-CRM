# Environment Setup

## Prerequisites
- Docker (Desktop or Engine) for PostgreSQL 16, Redis 7 and Mailpit
- `uv` ≥ 0.11 (installs Python 3.13 automatically)
- Node 20+ with `corepack enable pnpm` (pnpm 10)

## First run
```bash
cp .env.example .env                      # local-only values; never commit .env
docker compose up -d postgres redis mailpit
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
Mailpit UI: http://localhost:8025 (verification, invitation and reset emails land here).

PostgreSQL is published on host port **5433** (5432 is often taken locally). The init script creates the
`crm_app` role as **non-superuser without RLS bypass**, so Row Level Security is exercised in dev and tests.

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
