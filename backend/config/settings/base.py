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
    "apps.companies",
    "apps.contacts",
    "apps.products",
    "apps.pipelines",
    "apps.deals",
    "apps.notes",
    "apps.search",
    "apps.importexport",
]

MIDDLEWARE = [
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
    "allauth.usersessions.middleware.UserSessionsMiddleware",
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
DATABASES = {
    "default": {
        **env.db("DATABASE_URL"),
        "CONN_MAX_AGE": 0,
        "CONN_HEALTH_CHECKS": True,
        "OPTIONS": {"options": "-c statement_timeout=15000"},
    }
}
# Transactions are opened by TenantMiddleware (so SET LOCAL covers the whole request).
ATOMIC_REQUESTS = False
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

REDIS_URL = env("REDIS_URL", default="redis://localhost:6379/0")
CACHES = {
    "default": {
        "BACKEND": "django_redis.cache.RedisCache",
        "LOCATION": REDIS_URL,
        "OPTIONS": {"CLIENT_CLASS": "django_redis.client.DefaultClient"},
        "KEY_PREFIX": "keel",
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
PRIVATE_STORAGE_ROOT = env("PRIVATE_STORAGE_ROOT", default=str(BASE_DIR / "private"))

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
CELERY_TASK_TIME_LIMIT = 600
CELERY_TASK_SOFT_TIME_LIMIT = 540
CELERY_WORKER_PREFETCH_MULTIPLIER = 1
CELERY_TASK_DEFAULT_QUEUE = "default"
CELERY_BEAT_SCHEDULER = "django_celery_beat.schedulers:DatabaseScheduler"
CELERY_BROKER_CONNECTION_RETRY_ON_STARTUP = True

# ----------------------------------------------------------------------------- i18n / static
LANGUAGE_CODE = "en"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True
STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

# ----------------------------------------------------------------------------- product limits
MAX_ORGANIZATIONS_PER_USER = 5
MAX_PENDING_INVITATIONS_PER_ORG = 200
INVITATION_EXPIRY_DAYS = 7
