"""Production settings. The process refuses to start if any hardening requirement is missing."""

from config.settings.base import *  # noqa: F403
from config.settings.base import (
    ALLOWED_HOSTS,
    CSRF_TRUSTED_ORIGINS,
    DATABASES,
    ENVIRONMENT,
    MESSAGING_ENCRYPTION_KEYS,
    PRIVATE_STORAGE_BACKEND,
    PRIVATE_STORAGE_BUCKET,
    SECRET_KEY,
    env,
)
from security.logging import configure_logging

DEBUG = False

if ENVIRONMENT not in {"production", "staging"}:
    raise RuntimeError("config.settings.prod requires ENVIRONMENT=production or staging.")
if not ALLOWED_HOSTS:
    raise RuntimeError("ALLOWED_HOSTS must be set in production.")
if not CSRF_TRUSTED_ORIGINS:
    raise RuntimeError("CSRF_TRUSTED_ORIGINS must be set in production.")
if len(SECRET_KEY) < 50 or "insecure" in SECRET_KEY:
    raise RuntimeError("SECRET_KEY is missing or weak.")
if PRIVATE_STORAGE_BACKEND == "s3" and not PRIVATE_STORAGE_BUCKET:
    raise RuntimeError("PRIVATE_STORAGE_BUCKET must be set when PRIVATE_STORAGE_BACKEND=s3.")
if not MESSAGING_ENCRYPTION_KEYS:
    raise RuntimeError("MESSAGING_ENCRYPTION_KEYS must be set (Fernet keys for stored provider tokens).")
if PRIVATE_STORAGE_BACKEND == "filesystem" and not env.bool("ALLOW_LOCAL_PRIVATE_STORAGE", default=False):
    # A second instance or a redeploy would lose in-flight imports/exports on a container filesystem.
    raise RuntimeError("PRIVATE_STORAGE_BACKEND=filesystem is single-instance only; use s3 in production.")

# TLS termination happens at the load balancer; it strips client-supplied X-Forwarded-Proto.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = True
# Probes come over plain HTTP from the load balancer (HealthProbeMiddleware answers them first; this
# keeps the routed views reachable for tooling that bypasses the middleware).
SECURE_REDIRECT_EXEMPT = [r"^health/", r"^ready/$"]
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SESSION_COOKIE_NAME = "__Host-keel_session"
CSRF_COOKIE_NAME = "__Host-keel_csrftoken"
SECURE_HSTS_SECONDS = env.int("SECURE_HSTS_SECONDS", default=300)  # ramp: 300 → 86400 → 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = env.bool("SECURE_HSTS_INCLUDE_SUBDOMAINS", default=False)
SECURE_HSTS_PRELOAD = False  # only after documented domain readiness review

DATABASES["default"]["OPTIONS"] = {
    **DATABASES["default"].get("OPTIONS", {}),
    "sslmode": env("DB_SSLMODE", default="verify-full"),
    "sslrootcert": env("DB_SSLROOTCERT", default="/etc/ssl/certs/ca-certificates.crt"),
}

# Redis outage must not take login and browsing down (sessions degrade to the database).
CACHE_FAIL_OPEN = env.bool("CACHE_FAIL_OPEN", default=True)
CACHES["default"]["OPTIONS"]["IGNORE_EXCEPTIONS"] = CACHE_FAIL_OPEN  # noqa: F405

ACCOUNT_DEFAULT_HTTP_PROTOCOL = "https"
MFA_WEBAUTHN_ALLOW_INSECURE_ORIGIN = False

LOGGING = configure_logging(json_output=True, level=env("LOG_LEVEL", default="INFO"))
