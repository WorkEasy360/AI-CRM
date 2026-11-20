# syntax=docker/dockerfile:1.7
# Multi-stage build: dependencies resolved from the committed lock file, runtime image runs as non-root.

FROM python:3.13-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:0.11.21 /uv /uvx /bin/
# The WorkEasy360 sign-in connector is a git dependency on a private repository, locked by its SSH URL
# (docs/workeasy360-sso.md, "Installing the connector"). git and the SSH client exist in this stage only. For the SSH
# path, github.com's host keys are pinned exactly as GitHub publishes them (https://api.github.com/meta, "ssh_keys";
# fingerprints: Ed25519 SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU, ECDSA
# SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM, RSA SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s); no
# other host key is trusted and an unknown or changed one is refused.
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
# Read access to the connector's repository reaches this one step, in one of two ways:
# - a short-lived token as the BuildKit secret `workeasy360_sso_token`. CI passes a one-hour, read-only GitHub App
#   installation token (build-push-action `secret-envs`); locally: `--secret id=workeasy360_sso_token,env=GH_TOKEN`.
#   git fetches the locked SSH URL over HTTPS with it, set in this command's environment only.
# - otherwise the caller's ssh-agent (`docker build --ssh default`; docker compose forwards it with `ssh: [default]`).
# With neither, the build stops here and says so. The secret and the agent are mounted for this step alone, and git's
# clone stays in the cache mount, so no token, no key and no .git lands in any layer: only the installed package does.
RUN --mount=type=secret,id=workeasy360_sso_token,required=false \
    --mount=type=ssh,required=false \
    --mount=type=cache,target=/root/.cache/uv \
    if [ -s /run/secrets/workeasy360_sso_token ]; then \
        GIT_CONFIG_COUNT=1 \
        GIT_CONFIG_KEY_0="url.https://x-access-token:$(tr -d '[:space:]' </run/secrets/workeasy360_sso_token)@github.com/WorkEasy360/workeasy360-sso.git.insteadOf" \
        GIT_CONFIG_VALUE_0="ssh://git@github.com/WorkEasy360/workeasy360-sso.git" \
        GIT_TERMINAL_PROMPT=0 \
        uv sync --frozen --no-dev --no-install-project; \
    elif [ -S "${SSH_AUTH_SOCK:-}" ]; then \
        uv sync --frozen --no-dev --no-install-project; \
    else \
        echo "error: the WorkEasy360 sign-in connector is in the private repository WorkEasy360/workeasy360-sso." \
            "Build with --secret id=workeasy360_sso_token,env=GH_TOKEN (GH_TOKEN: a token that can read it, e.g. from" \
            "'gh auth token') or with --ssh default (an ssh-agent holding a key that can)." \
            "See docs/workeasy360-sso.md, Installing the connector." >&2; \
        exit 1; \
    fi
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
