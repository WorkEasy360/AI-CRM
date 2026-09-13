"""Production settings. The process refuses to start if any hardening requirement is missing."""

from config.settings.base import *  # noqa: F403
from config.settings.base import ALLOWED_HOSTS, CSRF_TRUSTED_ORIGINS, DATABASES, ENVIRONMENT, SECRET_KEY, env
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

# TLS termination happens at the load balancer; it strips client-supplied X-Forwarded-Proto.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = True
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
DATABASES["default"]["CONN_MAX_AGE"] = env.int("DB_CONN_MAX_AGE", default=0)

CACHES["default"]["OPTIONS"]["CONNECTION_POOL_KWARGS"] = {"max_connections": 50}  # noqa: F405

ACCOUNT_DEFAULT_HTTP_PROTOCOL = "https"
MFA_WEBAUTHN_ALLOW_INSECURE_ORIGIN = False

LOGGING = configure_logging(json_output=True, level=env("LOG_LEVEL", default="INFO"))
