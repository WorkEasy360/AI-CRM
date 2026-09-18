"""Shared lifecycle for CRM records (contacts, companies, deals, products).

One implementation of create / update / archive / restore / reassign / bulk so that authorization,
optimistic concurrency, ownership rules and audit logging cannot drift between modules. Module
services call these with a ``RecordSpec`` and add their own invariants around them.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from django.db import transaction
from django.db.models import F
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from apps.accounts.models import Membership
from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.catalogue import SCOPE_ALL
from apps.authz.service import check, scope
from apps.core.concurrency import save_with_version
from apps.core.exceptions import DomainError
from apps.core.models import CrmRecord
from apps.dashboards import cache as dashboard_cache

MAX_BULK_IDS = 500
BULK_ACTIONS = ("archive", "restore", "reassign", "add_tag", "remove_tag")


@dataclass(frozen=True)
class RecordSpec:
    module: str  # permission prefix: "contacts"
    entity_type: str  # custom fields / tags / notes key: "contact"
    model: type[CrmRecord]
    display: Callable[[Any], str]
    reassign_permission: str | None = None  # e.g. "deals.reassign"; None → update at scope "all"

    def perm(self, action: str) -> str:
        return f"{self.module}.{action}"


def can_reassign(actor: Actor, spec: RecordSpec) -> bool:
    if spec.reassign_permission:
        return actor.has(spec.reassign_permission)
    return actor.scope_for(spec.perm("update")) == SCOPE_ALL


def resolve_owner(
    actor: Actor, spec: RecordSpec, owner: Membership | None, *, current: Membership | None
) -> Membership | None:
    """Decide the owner for a write. Only actors allowed to reassign may pick someone else."""
    if owner is None:
        return current
    if current is not None and owner.pk == current.pk:
        return current
    if owner.pk == actor.membership.pk and current is None:
        return owner
    if not can_reassign(actor, spec):
        raise PermissionDenied(detail="You cannot assign records to other members.", code="reassign_denied")
    if owner.status != Membership.Status.ACTIVE:
        raise ValidationError({"owner_id": "Owner must be an active member."})
    return owner


@transaction.atomic
def create(
    actor: Actor, spec: RecordSpec, data: dict[str, Any], *, request: Any = None, audit_extra: dict | None = None
):
    dashboard_cache.invalidate(actor.organization.pk)
    check(actor, spec.perm("create"))
    if "custom_data" not in data:
        # Required custom fields apply even when the client omits custom_data entirely.
        from apps.customfields import service as customfields

        data["custom_data"] = customfields.validate_values(spec.entity_type, {}, partial=False)
    owner = resolve_owner(actor, spec, data.pop("owner", None), current=None) or actor.membership
    obj = spec.model(**data, owner=owner, created_by=actor.membership, updated_by=actor.membership)
    obj.save()
    audit.record(
        f"{spec.module}.created",
        request=request,
        user=actor.user,
        resource=obj,
        resource_type=spec.entity_type,
        metadata={"name": spec.display(obj), "owner_id": str(owner.pk), **(audit_extra or {})},
    )
    return obj


def check_update(actor: Actor, spec: RecordSpec, obj: Any) -> None:
    """Authorize an edit of ``obj`` (used by callers that write through a side service first)."""
    check(actor, spec.perm("update"), obj)
    if obj.archived_at is not None:
        raise DomainError("Restore the record before editing it.", code="record_archived", status_code=409)


@transaction.atomic
def update(
    actor: Actor,
    spec: RecordSpec,
    obj: Any,
    data: dict[str, Any],
    *,
    expected_version: int | None,
    request: Any = None,
    extra_update_fields: list[str] | None = None,
):
    dashboard_cache.invalidate(actor.organization.pk)
    check(actor, spec.perm("update"), obj)
    if obj.archived_at is not None:
        raise DomainError("Restore the record before editing it.", code="record_archived", status_code=409)
    changed: list[str] = []
    metadata: dict[str, Any] = {}
    if "owner" in data:
        new_owner = resolve_owner(actor, spec, data.pop("owner"), current=obj.owner)
        if new_owner is not None and (obj.owner_id != new_owner.pk):
            metadata["owner_from"] = str(obj.owner_id) if obj.owner_id else None
            metadata["owner_to"] = str(new_owner.pk)
            obj.owner = new_owner
            changed.append("owner")
    for field_name, value in data.items():
        if getattr(obj, field_name) != value:
            setattr(obj, field_name, value)
            changed.append(field_name)
    changed.extend(f for f in (extra_update_fields or []) if f not in changed)
    if not changed:
        # Still enforce the version contract so a stale client learns it is stale.
        if expected_version is not None and expected_version != obj.version:
            from apps.core.exceptions import ConflictError

            raise ConflictError(
                "The record was modified by someone else. Reload and try again.", code="version_conflict"
            )
        return obj
    obj.updated_by = actor.membership
    save_with_version(obj, expected_version, [*changed, "updated_by"])
    metadata["fields"] = sorted(changed)
    audit.record(
        f"{spec.module}.reassigned" if "owner" in changed and len(changed) == 1 else f"{spec.module}.updated",
        request=request,
        user=actor.user,
        resource=obj,
        resource_type=spec.entity_type,
        metadata=metadata,
    )
    if "owner" in changed and spec.entity_type == "deal" and obj.owner_id and obj.owner_id != actor.membership.pk:
        from apps.notifications import service as notifications

        notifications.notify(
            obj.owner_id,
            kind="deal_assigned",
            title=f"{spec.display(obj)} was assigned to you",
            body=f"Assigned by {actor.user.display_name}.",
            entity_type="deal",
            entity_id=obj.pk,
        )
    return obj


@transaction.atomic
def archive(actor: Actor, spec: RecordSpec, obj: Any, *, request: Any = None):
    dashboard_cache.invalidate(actor.organization.pk)
    check(actor, spec.perm("delete"), obj)
    if obj.archived_at is not None:
        return obj
    obj.archived_at = timezone.now()
    obj.updated_by = actor.membership
    save_with_version(obj, None, ["archived_at", "updated_by"])
    audit.record(
        f"{spec.module}.archived",
        request=request,
        user=actor.user,
        resource=obj,
        resource_type=spec.entity_type,
        metadata={"name": spec.display(obj)},
    )
    return obj


@transaction.atomic
def restore(actor: Actor, spec: RecordSpec, obj: Any, *, request: Any = None):
    dashboard_cache.invalidate(actor.organization.pk)
    check(actor, spec.perm("delete"), obj)
    if obj.archived_at is None:
        return obj
    obj.archived_at = None
    obj.updated_by = actor.membership
    save_with_version(obj, None, ["archived_at", "updated_by"])
    audit.record(
        f"{spec.module}.restored",
        request=request,
        user=actor.user,
        resource=obj,
        resource_type=spec.entity_type,
        metadata={"name": spec.display(obj)},
    )
    return obj


@transaction.atomic
def bulk(
    actor: Actor,
    spec: RecordSpec,
    *,
    ids: list[uuid.UUID],
    action: str,
    payload: dict[str, Any],
    request: Any = None,
) -> dict[str, Any]:
    """Apply one action to many records. Refuses the whole request if any id is outside the scope."""
    check(actor, spec.perm("bulk_update"))
    dashboard_cache.invalidate(actor.organization.pk)
    if action not in BULK_ACTIONS:
        raise ValidationError({"action": f"Allowed actions: {', '.join(BULK_ACTIONS)}."})
    if len(ids) > MAX_BULK_IDS:
        raise ValidationError({"ids": f"At most {MAX_BULK_IDS} ids per request."})
    permission = spec.perm("delete") if action in {"archive", "restore"} else spec.perm("update")
    qs = scope(actor, permission, spec.model.objects.filter(pk__in=ids))
    qs = qs.filter(archived_at__isnull=(action != "restore"))
    records = list(qs.select_for_update())
    if len(records) != len(ids):
        raise DomainError(
            f"{len(ids) - len(records)} record(s) are not accessible for this action.",
            code="bulk_out_of_scope",
        )
    now = timezone.now()
    affected = 0
    metadata: dict[str, Any] = {"action": action, "count": len(records), "ids": [str(r.pk) for r in records][:50]}
    # Bulk writes bump ``version`` exactly like single-record saves (ADR-0007): otherwise a client still
    # holding the old version could PATCH straight over a bulk archive or reassignment without a 409.
    if action in {"archive", "restore"}:
        affected = spec.model.objects.filter(pk__in=[r.pk for r in records]).update(
            archived_at=now if action == "archive" else None,
            updated_by=actor.membership,
            updated_at=now,
            version=F("version") + 1,
        )
    elif action == "reassign":
        owner_id = payload.get("owner_id")
        if not owner_id:
            raise ValidationError({"owner_id": "owner_id is required."})
        if not can_reassign(actor, spec):
            raise PermissionDenied(detail="You cannot assign records to other members.", code="reassign_denied")
        owner = Membership.objects.active().filter(pk=owner_id).first()
        if owner is None:
            raise ValidationError({"owner_id": "Unknown member."})
        affected = spec.model.objects.filter(pk__in=[r.pk for r in records]).update(
            owner=owner, updated_by=actor.membership, updated_at=now, version=F("version") + 1
        )
        metadata["owner_to"] = str(owner.pk)
    elif action in {"add_tag", "remove_tag"}:
        from apps.tagging import service as tagging
        from apps.tagging.models import Tag, TaggedItem

        tag_id = payload.get("tag_id")
        if not tag_id:
            raise ValidationError({"tag_id": "tag_id is required."})
        tag = Tag.objects.filter(pk=tag_id).first()
        if tag is None:
            raise ValidationError({"tag_id": "Unknown tag."})
        if action == "add_tag":
            affected = tagging.add_tag_bulk(spec.entity_type, records, tag)
        else:
            affected, _ = TaggedItem.objects.filter(
                tag=tag, entity_type=spec.entity_type, entity_id__in=[r.pk for r in records]
            ).delete()
        metadata["tag_id"] = str(tag.pk)
    audit.record(f"{spec.module}.bulk_{action}", request=request, user=actor.user, metadata=metadata)
    return {"action": action, "requested": len(ids), "affected": affected}
