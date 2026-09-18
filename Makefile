.PHONY: dev worker worker-heavy beat seed-loadtest services stop test test-backend test-frontend lint typecheck security rls-check schema rag-index

services:
	docker compose up -d --wait postgres redis mailpit

stop:
	docker compose down

dev: services
	cd backend && uv run python manage.py migrate && uv run python manage.py runserver 8000

worker: services
	cd backend && uv run celery -A config.celery worker -l info -Q default,notifications -c 4

worker-heavy: services
	cd backend && uv run celery -A config.celery worker -l info -Q imports,exports,reports,rag_indexing,integrations -c 2

beat: services
	cd backend && uv run celery -A config.celery beat -l info --scheduler django_celery_beat.schedulers:DatabaseScheduler

rag-index:
	cd backend && uv run python manage.py rebuild_rag_index --all

seed-loadtest:
	cd backend && uv run python manage.py seed_loadtest --out ../loadtest/users.json

test: test-backend test-frontend

test-backend:
	cd backend && uv run pytest

test-frontend:
	cd frontend && pnpm test

lint:
	cd backend && uv run ruff check . && uv run ruff format --check .
	cd frontend && pnpm lint

typecheck:
	cd backend && uv run mypy .
	cd frontend && pnpm typecheck

security:
	cd backend && uv run bandit -c pyproject.toml -r apps config security -q
	cd backend && uv run pip-audit
	cd backend && uv run semgrep --config ../security/semgrep --config p/django --error --quiet .
	gitleaks detect --source . --config .gitleaks.toml --no-banner

rls-check:
	cd backend && uv run python manage.py rls_check

schema:
	cd backend && uv run python manage.py spectacular --file ../frontend/openapi.json --format openapi-json
