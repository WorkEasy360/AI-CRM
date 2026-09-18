import os

os.environ.setdefault("SECRET_KEY", "test-only-secret-key-not-for-production-use-0000000000")
os.environ.setdefault("DATABASE_URL", "postgres://crm_app:crm_app_dev_password@localhost:5433/keel")
os.environ.setdefault("ENVIRONMENT", "test")

from config.settings.base import *  # noqa: F403
from config.settings.base import INSTALLED_APPS, REST_FRAMEWORK
from security.logging import configure_logging

DEBUG = False
ALLOWED_HOSTS = ["testserver", "localhost", "127.0.0.1"]
CSRF_TRUSTED_ORIGINS = ["http://testserver"]

INSTALLED_APPS = [*INSTALLED_APPS, "tests.testapp"]
ROOT_URLCONF = "tests.urls"

CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "keel-tests"}}
SESSION_ENGINE = "django.contrib.sessions.backends.db"
EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]
CELERY_TASK_ALWAYS_EAGER = True
CELERY_TASK_EAGER_PROPAGATES = True
MESSAGING_PROVIDER_BACKEND = "fake"
AI_PROVIDER_BACKEND = "fake"
WHATSAPP_APP_SECRET = "test-app-secret"  # nosec B105 - test-only value
WHATSAPP_VERIFY_TOKEN = "test-verify-token"  # nosec B105 - test-only value

SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False
SECURE_SSL_REDIRECT = False
MFA_WEBAUTHN_ALLOW_INSECURE_ORIGIN = True
# The suite asserts real authentication; never inherit a developer's AUTO_LOGIN_ENABLED from .env.
AUTO_LOGIN_ENABLED = False

# Generous default rates so functional tests never trip throttles; throttle tests override these.
REST_FRAMEWORK = {
    **REST_FRAMEWORK,
    "DEFAULT_THROTTLE_RATES": {
        "anon": "10000/min",
        "user": "10000/min",
        "auth": "10000/min",
        "admin": "10000/min",
        "sensitive": "10000/min",
        "invitation_public": "10000/min",
        "search": "10000/min",
        "assistant": "10000/min",
        "machine_credential": "10000/min",
        "machine_org": "10000/min",
        "machine_endpoint": "10000/min",
        "integration_inbound": "10000/min",
    },
}
ACCOUNT_RATE_LIMITS = {}

LOGGING = configure_logging(json_output=False, level="WARNING")
