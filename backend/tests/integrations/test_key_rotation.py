"""Encryption key rotation for stored provider secrets."""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from django.core.management import call_command
from django.core.management.base import CommandError

from apps.core import crypto
from apps.core.tenancy.context import tenant_context
from apps.integrations import credentials

pytestmark = pytest.mark.security


@pytest.fixture
def keys(settings):
    old, new = Fernet.generate_key().decode(), Fernet.generate_key().decode()
    settings.MESSAGING_ENCRYPTION_KEYS = old
    crypto.reset_key_cache()
    yield old, new
    crypto.reset_key_cache()


def test_rotation_rewrites_secrets_under_the_new_key(org_a, crm, keys, settings):
    old, new = keys
    connection = crm.make_integration_connection(org_a, credentials_enc=credentials.seal({"api_key": "k-123"}))
    hook = crm.make_webhook_subscription(org_a, secret_enc=crypto.encrypt("whsec_abc"))

    settings.MESSAGING_ENCRYPTION_KEYS = f"{new},{old}"
    call_command("reencrypt_secrets")

    settings.MESSAGING_ENCRYPTION_KEYS = new  # the old key is gone
    crypto.reset_key_cache()
    with tenant_context(org_a.org.pk):
        connection.refresh_from_db()
        hook.refresh_from_db()
    assert credentials.unseal(connection.credentials_enc) == {"api_key": "k-123"}
    assert crypto.decrypt(hook.secret_enc) == "whsec_abc"


def test_rotation_refuses_to_pass_when_a_value_is_unreadable(org_a, crm, keys, settings):
    _, new = keys
    crm.make_integration_connection(org_a, credentials_enc=credentials.seal({"api_key": "k"}))
    settings.MESSAGING_ENCRYPTION_KEYS = new  # old key removed too early
    crypto.reset_key_cache()
    with pytest.raises(CommandError):
        call_command("reencrypt_secrets")
