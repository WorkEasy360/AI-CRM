"""Attachment upload/download/delete.

The bytes never touch MEDIA or STATIC: they go to the same private storage the CSV
importer/exporter uses, under a server-generated key (``<org>/files/<random>.bin``) so client input
can never influence a path. Downloads are authorized, audited and always handed out as attachments.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from django.db import transaction
from django.http import Http404
from rest_framework.exceptions import PermissionDenied, ValidationError

from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.service import check
from apps.files.models import (
    ALLOWED_CONTENT_TYPES,
    MAX_FILE_BYTES,
    MAX_FILES_PER_RECORD,
    FileAttachment,
)
from apps.importexport import storage
from apps.notes.registry import resolve_viewable

_FILENAME_RE = re.compile(r"[^A-Za-z0-9._ -]+")


@dataclass(frozen=True)
class Download:
    filename: str
    content_type: str
    data: bytes | None = None
    url: str | None = None


def _safe_filename(name: str) -> str:
    cleaned = _FILENAME_RE.sub("_", (name or "").strip())[:255].lstrip(".")
    return cleaned or "attachment"


@transaction.atomic
def upload_file(
    actor: Actor,
    *,
    entity_type: str,
    entity_id: Any,
    filename: str,
    content_type: str,
    blob: bytes,
    request: Any = None,
) -> FileAttachment:
    check(actor, "files.upload")
    record = resolve_viewable(actor, entity_type, entity_id)
    if len(blob) == 0:
        raise ValidationError({"file": "The file is empty."})
    if len(blob) > MAX_FILE_BYTES:
        raise ValidationError({"file": "Files are limited to 10 MB each."})
    if content_type not in ALLOWED_CONTENT_TYPES:
        raise ValidationError({"file": "This file type is not allowed."})
    existing = FileAttachment.objects.filter(entity_type=entity_type, entity_id=record.pk).count()
    if existing >= MAX_FILES_PER_RECORD:
        raise ValidationError({"file": f"A record can hold at most {MAX_FILES_PER_RECORD} files."})

    key = storage.new_key(actor.organization.pk, "files")
    storage.write(key, blob, content_type)
    try:
        attachment = FileAttachment.objects.create(
            entity_type=entity_type,
            entity_id=record.pk,
            filename=_safe_filename(filename),
            content_type=content_type,
            size_bytes=len(blob),
            storage_key=key,
            uploaded_by=actor.membership,
        )
    except Exception:
        storage.delete(key)  # never leave an orphaned blob behind
        raise
    transaction.on_commit(
        lambda: audit.record(
            "files.uploaded",
            request=request,
            user=actor.user,
            resource=attachment,
            metadata={
                "entity_type": entity_type,
                "entity_id": str(record.pk),
                "filename": attachment.filename,
                "size_bytes": attachment.size_bytes,
                "content_type": attachment.content_type,
            },
        )
    )
    return attachment


def open_download(actor: Actor, attachment: FileAttachment, *, request: Any = None) -> Download:
    """Authorize, audit and resolve a download.

    With the S3 backend the bytes never pass through the API: the caller is redirected to a
    short-lived signed URL that carries the attachment disposition itself.
    """
    check(actor, "files.view", attachment)
    resolve_viewable(actor, attachment.entity_type, attachment.entity_id)
    if storage.organization_of(attachment.storage_key) != attachment.organization_id:
        raise PermissionDenied(code="permission_denied")  # defensive: never serve across tenants
    if not storage.exists(attachment.storage_key):
        raise Http404
    if storage.supports_signed_urls():
        download = Download(
            filename=attachment.filename,
            content_type=attachment.content_type,
            url=storage.signed_download_url(attachment.storage_key, attachment.filename, attachment.content_type),
        )
    else:
        download = Download(
            filename=attachment.filename,
            content_type=attachment.content_type,
            data=storage.read(attachment.storage_key),
        )
    audit.record(
        "files.downloaded",
        request=request,
        user=actor.user,
        resource=attachment,
        metadata={"entity_type": attachment.entity_type, "entity_id": str(attachment.entity_id)},
    )
    return download


@transaction.atomic
def delete_file(actor: Actor, attachment: FileAttachment, *, request: Any = None) -> None:
    check(actor, "files.delete", attachment)
    file_id, entity_type, entity_id = attachment.pk, attachment.entity_type, attachment.entity_id
    filename, key = attachment.filename, attachment.storage_key
    attachment.delete()
    transaction.on_commit(lambda: storage.delete(key))  # only drop the blob once the row is really gone
    audit.record(
        "files.deleted",
        request=request,
        user=actor.user,
        resource_type="fileattachment",
        resource_id=file_id,
        metadata={"entity_type": entity_type, "entity_id": str(entity_id), "filename": filename},
    )
