from config.settings.base import *  # noqa: F403
from config.settings.base import CSRF_TRUSTED_ORIGINS, FRONTEND_ORIGIN, env
from security.logging import configure_logging

DEBUG = env.bool("DEBUG", default=True)
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=["localhost", "127.0.0.1"])
CSRF_TRUSTED_ORIGINS = CSRF_TRUSTED_ORIGINS or [FRONTEND_ORIGIN, "http://localhost:8000"]

SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False
SECURE_SSL_REDIRECT = False

HEADLESS_SERVE_SPECIFICATION = True
MFA_WEBAUTHN_ALLOW_INSECURE_ORIGIN = True

# There is no sign-in page: the CRM opens directly as AUTO_LOGIN_EMAIL. Set AUTO_LOGIN_ENABLED=0
# to get the normal authenticated behaviour back (every request then answers 401).
AUTO_LOGIN_ENABLED = env.bool("AUTO_LOGIN_ENABLED", default=True)

LOGGING = configure_logging(json_output=False, level="INFO")
