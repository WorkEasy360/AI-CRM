# syntax=docker/dockerfile:1.7
# Multi-stage build: dependencies resolved from the committed lock file, runtime image runs as non-root.

FROM python:3.13-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:0.11.21 /uv /uvx /bin/
# The WorkEasy360 sign-in connector is a git dependency on a private repository, fetched over SSH
# (docs/workeasy360-sso.md, "Installing the connector"). git and the SSH client exist in this stage only. github.com's
# host keys are pinned as GitHub publishes them (fingerprints in .github/actions/workeasy360-sso-access, which pins the
# same three lines); no other host key is trusted and an unknown or changed one is refused.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 /root/.ssh \
    && printf '%s\n' \
        'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' \
        'github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=' \
        'github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=' \
        > /root/.ssh/known_hosts \
    && printf '%s\n' 'Host *' '  GlobalKnownHostsFile /dev/null' '  StrictHostKeyChecking yes' '  BatchMode yes' \
        > /root/.ssh/config
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never
COPY pyproject.toml uv.lock ./
# The SSH mount forwards the caller's ssh-agent to this step alone (CI: the deploy key, via build-push-action's `ssh`
# input; locally: `docker build --ssh default`) and the build stops if none is forwarded. The private key never
# enters the build, and git's clone stays in the cache mount, so no key and no .git lands in any layer: only the
# installed package does.
RUN --mount=type=ssh,required=true \
    --mount=type=cache,target=/root/.cache/uv \
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
