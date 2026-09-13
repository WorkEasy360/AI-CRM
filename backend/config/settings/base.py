"""Settings shared by every environment. Secrets and hosts come only from the environment."""

from __future__ import annotations

from pathlib import Path

import environ

BASE_DIR = Path(__file__).resolve().parents[2]
REPO_DIR = BASE_DIR.parent

env = environ.Env()
_env_file = REPO_DIR / ".env"
if _env_file.exists():
    environ.Env.read_env(str(_env_file))

ENVIRONMENT = env("ENVIRONMENT", default="development")
SECRET_KEY = env("SECRET_KEY")
SECRET_KEY_FALLBACKS = env.list("SECRET_KEY_FALLBACKS", default=[])
DEBUG = False
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=[])
FRONTEND_ORIGIN = env("FRONTEND_ORIGIN", default="http://localhost:3000")
SITE_NAME = "Keel CRM"

# ----------------------------------------------------------------------------- apps / middleware
INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.postgres",
    "allauth",
    "allauth.account",
    "allauth.mfa",
    "allauth.usersessions",
    "allauth.headless",
    "rest_framework",
    "drf_spectacular",
    "csp",
    "django_celery_beat",
    "apps.core",
    "apps.accounts",
    "apps.authz",
    "apps.teams",
    "apps.audit",
    "apps.privacy",
    "apps.customfields",
    "apps.tagging",
    "apps.lifecycle",
    "apps.companies",
    "apps.contacts",
    "apps.products",
    "apps.pipelines",
    "apps.deals",
    "apps.notes",
    "apps.search",
    "apps.importexport",
    "apps.dashboards",
    "apps.observability",
    "apps.activities",
    "apps.notifications",
    "apps.forecasting",
    "apps.messaging",
    "apps.ai",
]

MIDDLEWARE = [
    # Probes are answered before host validation / HTTPS redirect (load balancers probe over plain HTTP).
    "security.middleware.HealthProbeMiddleware",
    # Real client address from X-Forwarded-For, trusting exactly TRUSTED_PROXY_COUNT hops.
    "security.middleware.ClientIPMiddleware",
    "security.middleware.RequestIDMiddleware",
    "security.middleware.RequestLoggingMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "csp.middleware.CSPMiddleware",
    "security.middleware.SecurityHeadersMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "allauth.account.middleware.AccountMiddleware",
    "apps.accounts.middleware.ThrottledUserSessionsMiddleware",
    "apps.core.tenancy.middleware.TenantMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    }
]

# ----------------------------------------------------------------------------- database / cache
# Per-connection server settings. Every value is a hard stop that turns a hung query into an error the
# client sees, instead of a thread that waits forever (statement_timeout also bounds RLS-heavy queries).
# The one-off migrate task raises DB_STATEMENT_TIMEOUT_MS; nothing else should.
_DB_OPTIONS_FLAGS = " ".join(
    [
        f"-c statement_timeout={env.int('DB_STATEMENT_TIMEOUT_MS', default=15000)}",
        f"-c lock_timeout={env.int('DB_LOCK_TIMEOUT_MS', default=5000)}",
        f"-c idle_in_transaction_session_timeout={env.int('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', default=60000)}",
    ]
)
# Connection strategy (docs/architecture/scaling.md, "Database connections"):
# - DB_POOL=true (production): psycopg's in-process pool, hard-capped at DB_POOL_MAX_SIZE connections per
#   process (default: one per gunicorn thread). A thread that cannot get a connection within
#   DB_POOL_TIMEOUT seconds fails fast instead of queueing. Total connections per task are therefore
#   bounded by GUNICORN_WORKERS x DB_POOL_MAX_SIZE, whatever the traffic does.
# - DB_POOL=false (development/tests): Django persistent connections (CONN_MAX_AGE).
# RLS context uses SET LOCAL (transaction-scoped), so both strategies and transaction-mode proxies
# (RDS Proxy / PgBouncer) are safe.
DB_POOL = env.bool("DB_POOL", default=False)
DB_POOL_MAX_SIZE = env.int("DB_POOL_MAX_SIZE", default=env.int("GUNICORN_THREADS", default=4))
DATABASES = {
    "default": {
        **env.db("DATABASE_URL"),
        "CONN_MAX_AGE": 0 if DB_POOL else env.int("DB_CONN_MAX_AGE", default=60),
        "CONN_HEALTH_CHECKS": True,
        "OPTIONS": {
            "options": _DB_OPTIONS_FLAGS,
            "connect_timeout": env.int("DB_CONNECT_TIMEOUT", default=5),
            # Named prepared statements pin connections on RDS Proxy / PgBouncer; keep them off.
            "prepare_threshold": None,
        },
    }
}
if DB_POOL:
    DATABASES["default"]["OPTIONS"]["pool"] = {
        "min_size": env.int("DB_POOL_MIN_SIZE", default=1),
        "max_size": DB_POOL_MAX_SIZE,
        "timeout": env.float("DB_POOL_TIMEOUT", default=5.0),
        "max_lifetime": env.int("DB_POOL_MAX_LIFETIME", default=1800),
        "max_idle": env.int("DB_POOL_MAX_IDLE", default=300),
        "reconnect_timeout": env.float("DB_POOL_RECONNECT_TIMEOUT", default=30.0),
    }
# Transactions are opened by TenantMiddleware (so SET LOCAL covers the whole request).
ATOMIC_REQUESTS = False
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

REDIS_URL = env("REDIS_URL", default="redis://localhost:6379/0")
# CACHE_FAIL_OPEN: when Redis is unreachable, cache reads return None and writes are dropped (logged) so
# sessions fall back to the database and pages keep loading. The price is that DRF/allauth throttles
# cannot count during the outage; the WAF rate rules remain as the outer limit. Production turns this on.
CACHE_FAIL_OPEN = env.bool("CACHE_FAIL_OPEN", default=False)
DJANGO_REDIS_LOG_IGNORED_EXCEPTIONS = True
CACHES = {
    "default": {
        "BACKEND": "django_redis.cache.RedisCache",
        "LOCATION": REDIS_URL,
        "OPTIONS": {
            "CLIENT_CLASS": "django_redis.client.DefaultClient",
            "IGNORE_EXCEPTIONS": CACHE_FAIL_OPEN,
            "SOCKET_CONNECT_TIMEOUT": env.float("REDIS_CONNECT_TIMEOUT", default=2.0),
            "SOCKET_TIMEOUT": env.float("REDIS_SOCKET_TIMEOUT", default=2.0),
            "CONNECTION_POOL_KWARGS": {
                # Per process: one per request thread plus headroom; total = tasks x workers x this.
                "max_connections": env.int("REDIS_MAX_CONNECTIONS", default=20),
                "retry_on_timeout": True,
            },
        },
        "KEY_PREFIX": "keel",
        # Nothing is cached without an expiry; every key has its own TTL (never rely on this default).
        "TIMEOUT": 300,
    }
}

# ----------------------------------------------------------------------------- auth / sessions
AUTH_USER_MODEL = "accounts.User"
# auth.W004: email uniqueness is enforced case-insensitively by a functional unique constraint
# (uniq_user_email_ci), which is stricter than the plain unique=True the check looks for.
SILENCED_SYSTEM_CHECKS = ["auth.W004"]
AUTHENTICATION_BACKENDS = [
    "allauth.account.auth_backends.AuthenticationBackend",
]
PASSWORD_HASHERS = [
    "django.contrib.auth.hashers.Argon2PasswordHasher",
    "django.contrib.auth.hashers.PBKDF2PasswordHasher",
]
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 12}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

SESSION_ENGINE = "django.contrib.sessions.backends.cached_db"
SESSION_COOKIE_NAME = "keel_session"
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_AGE = 14 * 24 * 3600  # absolute lifetime
SESSION_IDLE_TIMEOUT_SECONDS = 12 * 3600
SESSION_SAVE_EVERY_REQUEST = False
CSRF_COOKIE_NAME = "keel_csrftoken"
CSRF_COOKIE_HTTPONLY = False  # the SPA reads it to send X-CSRFToken; the token is not a bearer secret
CSRF_COOKIE_SAMESITE = "Lax"
CSRF_HEADER_NAME = "HTTP_X_CSRFTOKEN"
CSRF_USE_SESSIONS = False
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=[])

# allauth
ACCOUNT_ADAPTER = "apps.accounts.adapters.AccountAdapter"
HEADLESS_ADAPTER = "apps.accounts.adapters.HeadlessAdapter"
ACCOUNT_USER_MODEL_USERNAME_FIELD = None
ACCOUNT_LOGIN_METHODS = {"email"}
ACCOUNT_SIGNUP_FIELDS = ["email*", "password1*"]
ACCOUNT_SIGNUP_FORM_CLASS = "apps.accounts.forms.SignupForm"  # adds an optional display name
ACCOUNT_UNIQUE_EMAIL = True
ACCOUNT_EMAIL_VERIFICATION = "mandatory"
ACCOUNT_EMAIL_VERIFICATION_BY_CODE_ENABLED = False
ACCOUNT_EMAIL_CONFIRMATION_EXPIRE_DAYS = 1
ACCOUNT_LOGIN_ON_EMAIL_CONFIRMATION = False
ACCOUNT_PREVENT_ENUMERATION = "strict"
ACCOUNT_EMAIL_NOTIFICATIONS = True
ACCOUNT_LOGOUT_ON_PASSWORD_CHANGE = True
ACCOUNT_REAUTHENTICATION_TIMEOUT = 10 * 60
ACCOUNT_REAUTHENTICATION_REQUIRED = True
ACCOUNT_PASSWORD_MIN_LENGTH = 12
ACCOUNT_LOGIN_BY_CODE_ENABLED = False
ACCOUNT_SESSION_REMEMBER = None
ACCOUNT_EMAIL_SUBJECT_PREFIX = "[Keel] "
ACCOUNT_RATE_LIMITS = {
    "change_password": "5/m/user",  # nosec B105 - rate limit, not a secret
    "manage_email": "10/m/user",
    "reset_password": "20/m/ip,3/m/key",  # nosec B105
    "reauthenticate": "10/m/user",
    "reset_password_from_key": "20/m/ip",  # nosec B105
    "signup": "10/m/ip",
    "login": "20/m/ip",
    "login_failed": "10/m/ip,10/900s/key",
    "confirm_email": "1/180s/key",
}

MFA_SUPPORTED_TYPES = ["totp", "recovery_codes", "webauthn"]
MFA_PASSKEY_LOGIN_ENABLED = True
MFA_TOTP_ISSUER = SITE_NAME
MFA_RECOVERY_CODE_COUNT = 10

USERSESSIONS_TRACK_ACTIVITY = True
# Write "last seen" at most this often per session (see apps.accounts.middleware).
USERSESSIONS_ACTIVITY_INTERVAL = 300

HEADLESS_ONLY = True
HEADLESS_CLIENTS = ("browser",)
HEADLESS_SERVE_SPECIFICATION = False
HEADLESS_FRONTEND_URLS = {
    "account_confirm_email": FRONTEND_ORIGIN + "/verify-email/{key}",
    "account_reset_password": FRONTEND_ORIGIN + "/reset-password",
    "account_reset_password_from_key": FRONTEND_ORIGIN + "/reset-password/{key}",
    "account_signup": FRONTEND_ORIGIN + "/signup",
}

# ----------------------------------------------------------------------------- API
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework.authentication.SessionAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["apps.authz.permissions.DenyAll"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "DEFAULT_THROTTLE_CLASSES": [
        "security.throttles.AnonThrottle",
        "security.throttles.UserThrottle",
        "security.throttles.ScopedThrottle",
    ],
    # ClientIPMiddleware already resolved the real client into REMOTE_ADDR; DRF must not read
    # X-Forwarded-For itself (with NUM_PROXIES unset it would key throttles on a client-controlled header).
    "NUM_PROXIES": 0,
    "DEFAULT_THROTTLE_RATES": {
        "anon": "60/min",
        "user": "600/min",
        "auth": "10/min",
        "admin": "120/min",
        "sensitive": "30/min",
        "invitation_public": "20/min",
        "search": "120/min",
    },
    "DEFAULT_PAGINATION_CLASS": "apps.core.api.pagination.DefaultCursorPagination",
    "PAGE_SIZE": 50,
    "EXCEPTION_HANDLER": "apps.core.api.exceptions.problem_details_exception_handler",
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "TEST_REQUEST_DEFAULT_FORMAT": "json",
}

SPECTACULAR_SETTINGS = {
    "TITLE": "Keel CRM API",
    "VERSION": "1.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
    "COMPONENT_SPLIT_REQUEST": True,
    "SCHEMA_PATH_PREFIX": r"/api/v1",
}

DATA_UPLOAD_MAX_MEMORY_SIZE = 1 * 1024 * 1024
DATA_UPLOAD_MAX_NUMBER_FIELDS = 500
FILE_UPLOAD_MAX_MEMORY_SIZE = 2 * 1024 * 1024
# CSV imports/exports live outside MEDIA/STATIC and are never served directly (see apps.importexport.storage).
# "filesystem" is for a single local process; any multi-instance deployment must use "s3" so every
# instance and worker sees the same files.
PRIVATE_STORAGE_BACKEND = env("PRIVATE_STORAGE_BACKEND", default="filesystem")
PRIVATE_STORAGE_ROOT = env("PRIVATE_STORAGE_ROOT", default=str(BASE_DIR / "private"))
PRIVATE_STORAGE_BUCKET = env("PRIVATE_STORAGE_BUCKET", default="")
PRIVATE_STORAGE_KMS_KEY_ID = env("PRIVATE_STORAGE_KMS_KEY_ID", default="")
PRIVATE_STORAGE_URL_TTL_SECONDS = env.int("PRIVATE_STORAGE_URL_TTL_SECONDS", default=60)
AWS_REGION = env("AWS_REGION", default="ap-south-1")

# ----------------------------------------------------------------------------- security headers
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "strict-origin-when-cross-origin"
SECURE_CROSS_ORIGIN_OPENER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"

CONTENT_SECURITY_POLICY = {
    "DIRECTIVES": {
        "default-src": ("'none'",),
        "frame-ancestors": ("'none'",),
        "base-uri": ("'none'",),
        "form-action": ("'self'",),
    }
}

# ----------------------------------------------------------------------------- email
_email = env.email_url("EMAIL_URL", default="consolemail://")
EMAIL_BACKEND = _email["EMAIL_BACKEND"]
EMAIL_HOST = _email.get("EMAIL_HOST", "")
EMAIL_PORT = _email.get("EMAIL_PORT", 25)
EMAIL_HOST_USER = _email.get("EMAIL_HOST_USER", "")
EMAIL_HOST_PASSWORD = _email.get("EMAIL_HOST_PASSWORD", "")
EMAIL_USE_TLS = _email.get("EMAIL_USE_TLS", False)
EMAIL_USE_SSL = _email.get("EMAIL_USE_SSL", False)
DEFAULT_FROM_EMAIL = env("DEFAULT_FROM_EMAIL", default="no-reply@keel.local")

# ----------------------------------------------------------------------------- celery
CELERY_BROKER_URL = env("CELERY_BROKER_URL", default="redis://localhost:6379/1")
CELERY_RESULT_BACKEND = None
CELERY_TASK_ACKS_LATE = True
# A task whose worker dies is redelivered (with acks_late) instead of silently lost. Every task is
# idempotent by status checks (jobs), cache markers (emails) or being read-only (metrics).
CELERY_TASK_REJECT_ON_WORKER_LOST = True
CELERY_TASK_TIME_LIMIT = 600
CELERY_TASK_SOFT_TIME_LIMIT = 540
CELERY_WORKER_PREFETCH_MULTIPLIER = 1
CELERY_TASK_DEFAULT_QUEUE = "default"
CELERY_BEAT_SCHEDULER = "django_celery_beat.schedulers:DatabaseScheduler"
CELERY_BROKER_CONNECTION_RETRY_ON_STARTUP = True
CELERY_BROKER_CONNECTION_MAX_RETRIES = None  # keep reconnecting; the worker must outlive a Redis failover
CELERY_BROKER_TRANSPORT_OPTIONS = {
    # Redis has no real acks: an unacked message is redelivered after visibility_timeout. It must exceed
    # the longest task's hard limit (imports: 1h) or a slow import would be started twice.
    "visibility_timeout": env.int("CELERY_VISIBILITY_TIMEOUT", default=2 * 3600),
    "socket_timeout": 30,
    "socket_connect_timeout": 5,
    "socket_keepalive": True,
    "max_connections": env.int("CELERY_BROKER_MAX_CONNECTIONS", default=20),
    "retry_on_timeout": True,
}
# Queue isolation (docs/architecture/scaling.md, "Celery"): heavy work never shares a worker with the
# work the interactive product depends on. Worker services consume:
#   worker-critical: default, notifications      worker-heavy: imports, exports, reports
#   (ai is declared for Phase 5 and has no consumer yet)
CELERY_TASK_QUEUES = {
    name: {"exchange": name, "routing_key": name}
    for name in ("default", "imports", "exports", "notifications", "reports", "ai")
}
CELERY_TASK_ROUTES = {
    "importexport.run_import": {"queue": "imports"},
    "importexport.run_export": {"queue": "exports"},
    "importexport.purge_expired": {"queue": "default"},
    "accounts.send_email": {"queue": "notifications"},
    "observability.publish_celery_metrics": {"queue": "default"},
    "activities.send_reminders": {"queue": "notifications"},
    "notifications.deal_health_sweep": {"queue": "reports"},
    "messaging.send_email_message": {"queue": "notifications"},
    "messaging.send_whatsapp_message": {"queue": "notifications"},
    "messaging.sync_email_accounts": {"queue": "default"},
    "messaging.sync_email_account": {"queue": "default"},
}
CELERY_BEAT_SCHEDULE = {
    "observability.publish_celery_metrics": {
        "task": "observability.publish_celery_metrics",
        "schedule": 30.0,
        "options": {"expires": 25},  # a stale metrics tick is worthless; drop it rather than queue it
    },
    "importexport.purge_expired": {"task": "importexport.purge_expired", "schedule": 6 * 3600.0},
    "activities.send_reminders": {"task": "activities.send_reminders", "schedule": 60.0, "options": {"expires": 55}},
    "notifications.deal_health_sweep": {"task": "notifications.deal_health_sweep", "schedule": 24 * 3600.0},
    "messaging.sync_email_accounts": {
        "task": "messaging.sync_email_accounts",
        "schedule": 300.0,
        "options": {"expires": 280},
    },
}
# Emails are queued (notifications queue) unless a deployment opts out; tests run tasks eagerly.
EMAIL_ASYNC = env.bool("EMAIL_ASYNC", default=True)

# ----------------------------------------------------------------------------- scaling / observability
# Number of proxy hops that append to X-Forwarded-For in front of this process (CloudFront + ALB = 2).
TRUSTED_PROXY_COUNT = env.int("TRUSTED_PROXY_COUNT", default=0)
# Forwarded (public) requests to /health/ready/ get a shallow answer; only the load balancer's direct
# probes run the dependency checks.
HEALTH_READY_INTERNAL_ONLY = env.bool("HEALTH_READY_INTERNAL_ONLY", default=True)
SLOW_REQUEST_MS = env.int("SLOW_REQUEST_MS", default=1000)
EXPOSE_INSTANCE_HEADER = env.bool("EXPOSE_INSTANCE_HEADER", default=False)
# "log" prints metrics as structured log lines; "cloudwatch" publishes to CloudWatch (task role).
METRICS_BACKEND = env("METRICS_BACKEND", default="log")
METRICS_NAMESPACE = env("METRICS_NAMESPACE", default="Keel")
# Dashboard aggregates are cached per organization + membership + permission scope; a write to any
# CRM record of the organization invalidates them (version key), the TTL bounds staleness otherwise.
DASHBOARD_CACHE_SECONDS = env.int("DASHBOARD_CACHE_SECONDS", default=60)
# List "count" endpoints stop counting here and report the value as a lower bound.
LIST_COUNT_CAP = env.int("LIST_COUNT_CAP", default=10_000)
# Import/export fairness: an organization may have at most this many jobs pending or running at once.
MAX_ACTIVE_JOBS_PER_ORG = env.int("MAX_ACTIVE_JOBS_PER_ORG", default=3)

# ----------------------------------------------------------------------------- communication (email / WhatsApp)
# Provider credentials come only from the environment. Without them the UI shows "not configured" and
# nothing can be connected; provider tokens are stored encrypted with MESSAGING_ENCRYPTION_KEYS.
MESSAGING_PROVIDER_BACKEND = env("MESSAGING_PROVIDER_BACKEND", default="live")  # live | fake (dev/tests)
MESSAGING_ENCRYPTION_KEYS = env("MESSAGING_ENCRYPTION_KEYS", default="")
EMAIL_OAUTH_GOOGLE_CLIENT_ID = env("EMAIL_OAUTH_GOOGLE_CLIENT_ID", default="")
EMAIL_OAUTH_GOOGLE_CLIENT_SECRET = env("EMAIL_OAUTH_GOOGLE_CLIENT_SECRET", default="")
EMAIL_OAUTH_MICROSOFT_CLIENT_ID = env("EMAIL_OAUTH_MICROSOFT_CLIENT_ID", default="")
EMAIL_OAUTH_MICROSOFT_CLIENT_SECRET = env("EMAIL_OAUTH_MICROSOFT_CLIENT_SECRET", default="")
EMAIL_OAUTH_MICROSOFT_TENANT = env("EMAIL_OAUTH_MICROSOFT_TENANT", default="common")
WHATSAPP_API_VERSION = env("WHATSAPP_API_VERSION", default="v21.0")
WHATSAPP_APP_SECRET = env("WHATSAPP_APP_SECRET", default="")  # webhook signature (X-Hub-Signature-256)
WHATSAPP_VERIFY_TOKEN = env("WHATSAPP_VERIFY_TOKEN", default="")  # webhook verification handshake

# ----------------------------------------------------------------------------- AI
# The assistant never touches the database: it receives permission-checked, delimited context and
# returns drafts a person reviews. Model routing keeps cost bounded: the fast model drafts and
# summarises; the strong model reasons over a whole deal.
AI_PROVIDER_BACKEND = env("AI_PROVIDER_BACKEND", default="anthropic")  # anthropic | fake
ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY", default="")
AI_MODEL_FAST = env("AI_MODEL_FAST", default="claude-haiku-4-5")
AI_MODEL_STRONG = env("AI_MODEL_STRONG", default="claude-opus-5")
AI_MAX_TOKENS_DRAFT = env.int("AI_MAX_TOKENS_DRAFT", default=1200)
AI_MAX_TOKENS_SUMMARY = env.int("AI_MAX_TOKENS_SUMMARY", default=1500)
AI_REQUEST_TIMEOUT_SECONDS = env.float("AI_REQUEST_TIMEOUT_SECONDS", default=45.0)
AI_USER_REQUESTS_PER_HOUR = env.int("AI_USER_REQUESTS_PER_HOUR", default=60)
AI_ORG_TOKENS_PER_DAY = env.int("AI_ORG_TOKENS_PER_DAY", default=2_000_000)
# USD per million input / output tokens, used for the usage ledger's cost estimate.
AI_MODEL_RATES_USD_PER_MTOK = {
    "claude-opus-5": (5.0, 25.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-haiku-4-5": (1.0, 5.0),
    "default": (5.0, 25.0),
}

# ----------------------------------------------------------------------------- i18n / static
LANGUAGE_CODE = "en"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True
STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

# ----------------------------------------------------------------------------- product limits
MAX_ORGANIZATIONS_PER_USER = 5
# Defaults for the workspace created automatically for every verified account (editable in Settings).
DEFAULT_ORGANIZATION_CURRENCY = env("DEFAULT_ORGANIZATION_CURRENCY", default="INR")
DEFAULT_ORGANIZATION_TIMEZONE = env("DEFAULT_ORGANIZATION_TIMEZONE", default="Asia/Kolkata")
MAX_PENDING_INVITATIONS_PER_ORG = 200
INVITATION_EXPIRY_DAYS = 7
