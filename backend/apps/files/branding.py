"""The workspace logo (General settings). It lives with record files: the same private storage and checks.

Accounts (a platform app) only keeps the storage key in ``Organization.settings``; reading and writing the
bytes is done here, so the platform layer never depends on a domain app.
"""

from __future__ import annotations

from django.db import transaction

from apps.accounts.models import Organization
from apps.audit import actions
from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.reauth import require_recent_auth
from apps.authz.service import check
from apps.core.exceptions import DomainError
from apps.importexport import storage

MAX_LOGO_BYTES = 512 * 1024
# Raster formats only, identified by their bytes: SVG can carry script, and a declared type proves nothing.
_LOGO_SIGNATURES = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
)


def logo_type(blob: bytes) -> str | None:
    for signature, content_type in _LOGO_SIGNATURES:
        if blob.startswith(signature):
            return content_type
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return "image/webp"
    return None


def set_logo(actor: Actor, blob: bytes, *, request=None) -> Organization:
    check(actor, "org.update")
    require_recent_auth(request)
    if not blob or len(blob) > MAX_LOGO_BYTES:
        raise DomainError("Upload a logo of at most 512 KB.", code="logo_too_large")
    content_type = logo_type(blob)
    if content_type is None:
        raise DomainError("Upload a PNG, JPEG or WebP image.", code="logo_unsupported")
    org = Organization.objects.get(pk=actor.organization.pk)
    old_key = org.logo_key
    key = storage.new_key(org.pk, "files")  # permanent and opaque, like record files
    storage.write(key, blob, content_type)
    try:
        with transaction.atomic():
            org.settings = {**org.settings, "logo_key": key, "logo_type": content_type}
            org.save(update_fields=["settings", "updated_at"])
            audit.record(
                actions.ORG_UPDATED, request=request, user=actor.user, resource=org, metadata={"logo": "updated"}
            )
    except Exception:
        storage.delete(key)  # never leave an orphaned blob behind
        raise
    if old_key:
        transaction.on_commit(lambda: storage.delete(old_key))
    return org


def remove_logo(actor: Actor, *, request=None) -> Organization:
    check(actor, "org.update")
    require_recent_auth(request)
    org = Organization.objects.get(pk=actor.organization.pk)
    old_key = org.logo_key
    if not old_key:
        return org
    org.settings = {k: v for k, v in org.settings.items() if k not in ("logo_key", "logo_type")}
    org.save(update_fields=["settings", "updated_at"])
    audit.record(actions.ORG_UPDATED, request=request, user=actor.user, resource=org, metadata={"logo": "removed"})
    transaction.on_commit(lambda: storage.delete(old_key))
    return org


def read_logo(actor: Actor) -> tuple[bytes, str] | None:
    org = Organization.objects.get(pk=actor.organization.pk)
    key = org.logo_key
    # The key names its organization: a logo is only ever served to that organization's members.
    if not key or storage.organization_of(key) != org.pk or not storage.exists(key):
        return None
    return storage.read(key), str(org.settings.get("logo_type", "image/png"))
