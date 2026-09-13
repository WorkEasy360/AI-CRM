# syntax=docker/dockerfile:1.7
# Multi-stage build: dependencies resolved from the committed lock file, runtime image runs as non-root.

FROM python:3.13-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:0.11.21 /uv /uvx /bin/
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project
COPY . .
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

FROM python:3.13-slim AS runtime
RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --create-home --shell /usr/sbin/nologin app \
    && apt-get update \
    # Apply distribution security updates so the runtime never ships known-vulnerable OS packages.
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends libpq5 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    # The runtime never installs packages: drop pip (and its vendored msgpack/setuptools) and ensurepip
    # so the image carries no package-manager attack surface or unpatched vendored libraries.
    && rm -rf /usr/local/lib/python3.13/site-packages/pip* \
              /usr/local/lib/python3.13/ensurepip \
              /usr/local/bin/pip*
WORKDIR /app
COPY --from=builder --chown=app:app /app /app
# Filesystem private storage (single-instance/dev only; production uses S3). Present in the image so a
# named volume mounted here inherits app ownership instead of root's.
RUN mkdir -p /app/private && chown app:app /app/private
ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DJANGO_SETTINGS_MODULE=config.settings.prod
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health/', timeout=3).status == 200 else 1)"
# gthread workers: a page load fires several API calls in parallel; sync workers would queue them
# behind each other. Tenant context lives in a ContextVar and DB context is transaction-local,
# so threads are safe. Connections: workers x threads (persistent, CONN_MAX_AGE).
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000", "--worker-class", "gthread", "--workers", "3", "--threads", "4", "--timeout", "60", "--access-logfile", "-"]
