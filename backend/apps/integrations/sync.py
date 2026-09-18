"""Synchronization between CRM records and a connection.

Every operation passes the same gates, in order:

    tenant context (task / request)
      -> connection usable (status, credentials)
      -> integration identity (connected_by still active and still allowed to manage integrations)
      -> sharing policy for the entity and direction
      -> record-level authorization (``authz.scope`` with the identity's grants)
      -> field allowlist + mapping (``fields``)
      -> validation (the same write serializers the UI uses)
      -> CRM service layer (``records`` / ``deals.services``: permission checks, versioning, audit)
      -> RLS

Outbound pushes are idempotent (hash of the mapped values per record + ``Idempotency-Key``); inbound
records are matched only through ``IntegrationRecordMap`` (never fuzzy matching); two-way conflicts
follow the connection's strategy and are recorded, never silently overwritten.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import uuid
from dataclasses import dataclass
from typing import Any

import structlog
from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from apps.audit import actions as audit_actions
from apps.audit import service as audit
from apps.authz.service import scope
from apps.core import crypto
from apps.core.exceptions import DomainError
from apps.integrations import credentials as sealed
from apps.integrations import events, fields
from apps.integrations.identity import IntegrationActor, build_integration_actor
from apps.integrations.models import (
    ConflictStrategy,
    ConnectionStatus,
    Direction,
    FieldMapping,
    IntegrationConnection,
    IntegrationRecordMap,
    SharingPolicy,
    SyncConflict,
    SyncJob,
)
from apps.integrations.providers import get_provider
from apps.integrations.providers.base import ExternalRecord, ProviderContext, ProviderError

log = structlog.get_logger(__name__)

OUTBOUND = (Direction.OUTBOUND, Direction.TWO_WAY)
INBOUND = (Direction.INBOUND, Direction.TWO_WAY)
USABLE_STATUSES = (ConnectionStatus.CONNECTED, ConnectionStatus.SYNCING, ConnectionStatus.ERROR)
MAX_JOB_ERRORS = 20


# ----------------------------------------------------------------------------- entity plumbing


@dataclass(frozen=True)
class EntityBinding:
    model: Any
    spec: Any
    write_serializer: Any
    select_related: tuple[str, ...]


def binding(entity_type: str) -> EntityBinding:
    if entity_type == "contact":
        from apps.contacts.api import SPEC, ContactWriteSerializer
        from apps.contacts.models import Contact

        return EntityBinding(Contact, SPEC, ContactWriteSerializer, ("company",))
    if entity_type == "company":
        from apps.companies.api import SPEC as COMPANY_SPEC
        from apps.companies.api import CompanyWriteSerializer
        from apps.companies.models import Company

        return EntityBinding(Company, COMPANY_SPEC, CompanyWriteSerializer, ())
    if entity_type == "deal":
        from apps.deals.api import DealWriteSerializer
        from apps.deals.models import Deal
        from apps.deals.services import SPEC as DEAL_SPEC

        return EntityBinding(Deal, DEAL_SPEC, DealWriteSerializer, ("stage", "pipeline", "company"))
    raise ValidationError({"entity_type": "This data type cannot be synchronized."})


def _view_permission(entity_type: str) -> str:
    return f"{fields.entity(entity_type).permission_module}.view"


# ----------------------------------------------------------------------------- identity & context


def connection_permissions(connection: IntegrationConnection) -> frozenset[str]:
    """Permissions implied by the connection's sharing policies (nothing else is ever granted)."""
    permissions: set[str] = set()
    for policy in SharingPolicy.objects.filter(connection=connection).exclude(direction=Direction.NONE):
        spec = fields.ENTITIES.get(policy.entity_type)
        if spec is None or not spec.shareable:
            continue
        module = spec.permission_module
        permissions.add(f"{module}.view")
        if policy.direction in INBOUND:
            permissions.add(f"{module}.update")
            if spec.inbound_create:
                permissions.add(f"{module}.create")
        if module == "deals":
            permissions.add("pipelines.view")
    return frozenset(permissions)


def connection_actor(connection: IntegrationConnection) -> IntegrationActor | None:
    from apps.accounts.models import Membership

    membership = (
        Membership.objects.select_related("user", "role", "organization").filter(pk=connection.connected_by_id).first()
        if connection.connected_by_id
        else None
    )
    return build_integration_actor(
        membership,
        connection_permissions(connection),
        connection_id=connection.pk,
        require="integrations.manage",
    )


def provider_context(connection: IntegrationConnection) -> ProviderContext:
    try:
        creds = sealed.unseal(connection.credentials_enc)
    except (crypto.DecryptionError, ValueError) as exc:
        raise ProviderError("decrypt_failed", action_required=True) from exc
    return ProviderContext(connection=connection, credentials=creds)


def require_actor(connection: IntegrationConnection) -> IntegrationActor:
    actor = connection_actor(connection)
    if actor is None:
        raise ProviderError("member_lost_access", action_required=True)
    return actor


def mappings_for(connection: IntegrationConnection, entity_type: str) -> list[dict[str, str]]:
    rows = FieldMapping.objects.filter(connection=connection, entity_type=entity_type).order_by("crm_field")
    return [{"crm_field": m.crm_field, "external_field": m.external_field} for m in rows]


def policy_for(connection: IntegrationConnection, entity_type: str) -> SharingPolicy | None:
    return SharingPolicy.objects.filter(connection=connection, entity_type=entity_type).first()


# ----------------------------------------------------------------------------- connection health bookkeeping


def record_success(connection: IntegrationConnection, *, synced: bool = False) -> None:
    now = timezone.now()
    updates: dict[str, Any] = {"last_error_code": "", "consecutive_failures": 0, "updated_at": now}
    if synced:
        updates.update(last_sync_at=now, last_success_at=now)
    if connection.status in (ConnectionStatus.ERROR, ConnectionStatus.ACTION_REQUIRED, ConnectionStatus.SYNCING):
        updates["status"] = ConnectionStatus.CONNECTED
    IntegrationConnection.objects.filter(pk=connection.pk).update(**updates)
    for key, value in updates.items():
        setattr(connection, key, value)


def record_failure(connection: IntegrationConnection, error: ProviderError) -> None:
    """Keep the error code (never provider text) and alert admins when a person has to act."""
    from apps.integrations import alerts

    now = timezone.now()
    failures = connection.consecutive_failures + 1
    status = ConnectionStatus.ACTION_REQUIRED if error.action_required else ConnectionStatus.ERROR
    if connection.status == ConnectionStatus.DISABLED:
        status = ConnectionStatus.DISABLED
    IntegrationConnection.objects.filter(pk=connection.pk).update(
        status=status, last_error_code=error.code[:64], last_error_at=now, consecutive_failures=failures, updated_at=now
    )
    connection.status, connection.last_error_code, connection.consecutive_failures = status, error.code[:64], failures
    log.warning("integrations.connection_error", connection_id=str(connection.pk), code=error.code, status=error.status)
    if error.action_required or failures in (3, 10, 50):
        alerts.connection_problem(connection, error.code)


# ----------------------------------------------------------------------------- outbound


def push_record(connection: IntegrationConnection, entity_type: str, entity_id: uuid.UUID) -> str:
    """Send one CRM record to the connection. Returns an outcome code; raises ProviderError on failure."""
    if connection.status not in USABLE_STATUSES:
        return "connection_inactive"
    policy = policy_for(connection, entity_type)
    if policy is None or policy.direction not in OUTBOUND:
        return "not_shared"
    actor = require_actor(connection)
    bind = binding(entity_type)
    record = (
        scope(actor, _view_permission(entity_type), bind.model.objects.filter(pk=entity_id))
        .select_related(*bind.select_related)
        .first()
    )
    if record is None or record.archived_at is not None:
        return "not_visible"
    values = fields.outbound_values(entity_type, record, mappings_for(connection, entity_type))
    if not values:
        return "nothing_mapped"
    crm_hash = fields.stable_hash(values)
    record_map = IntegrationRecordMap.objects.filter(
        connection=connection, entity_type=entity_type, crm_record_id=record.pk
    ).first()
    if record_map is not None and record_map.last_crm_hash == crm_hash:
        return "unchanged"
    idempotency_key = hashlib.sha256(f"{connection.pk}:{entity_type}:{record.pk}:{crm_hash}".encode()).hexdigest()
    provider = get_provider(connection.provider)
    ctx = provider_context(connection)
    external_id = record_map.external_record_id if record_map else None
    try:
        result = provider.push(
            ctx,
            entity_type,
            resource=policy.external_resource,
            values=values,
            external_id=external_id,
            idempotency_key=idempotency_key,
        )
    except ProviderError as exc:
        if exc.code != "record_not_found" or record_map is None:
            raise
        # Deleted on the other side: forget the link and create it again once.
        record_map.delete()
        record_map = None
        result = provider.push(
            ctx,
            entity_type,
            resource=policy.external_resource,
            values=values,
            external_id=None,
            idempotency_key=idempotency_key,
        )
    now = timezone.now()
    try:
        with transaction.atomic():
            IntegrationRecordMap.objects.update_or_create(
                connection=connection,
                entity_type=entity_type,
                crm_record_id=record.pk,
                defaults={
                    "external_record_id": result.external_id,
                    "last_synced_version": record.version,
                    "last_crm_hash": crm_hash,
                    "last_synced_at": now,
                },
            )
    except IntegrityError as exc:
        raise ProviderError("duplicate_external_id") from exc
    return "pushed"


# ----------------------------------------------------------------------------- inbound


def _split_values(values: dict[str, Any]) -> dict[str, Any]:
    data = {k: v for k, v in values.items() if not k.startswith(fields.CUSTOM_PREFIX)}
    custom = {k[len(fields.CUSTOM_PREFIX) :]: v for k, v in values.items() if k.startswith(fields.CUSTOM_PREFIX)}
    if custom:
        data["custom_data"] = custom
    return data


def _differs(record: Any, crm_field: str, incoming: Any) -> bool:
    try:
        current = fields.read_field(record, crm_field)
    except (AttributeError, ValueError):
        return True
    if current is None and incoming in ("", None):
        return False
    return str(current) != str(incoming)


def _write(actor: IntegrationActor, entity_type: str, record: Any | None, values: dict[str, Any]) -> Any:
    """Validate with the module's write serializer and save through the CRM service layer."""
    from apps.crm import records

    bind = binding(entity_type)
    data = _split_values(values)
    ser = bind.write_serializer(record, data=data, partial=record is not None, context={"actor": actor})
    ser.is_valid(raise_exception=True)
    validated = dict(ser.validated_data)
    if entity_type == "deal":
        from apps.deals import services as deal_services

        if record is None:
            raise PermissionDenied(code="permission_denied")
        return deal_services.update_deal(actor, record, validated, expected_version=None)
    if record is None:
        return records.create(actor, bind.spec, validated)
    return records.update(actor, bind.spec, record, validated, expected_version=None)


def apply_inbound(connection: IntegrationConnection, entity_type: str, external: ExternalRecord) -> str:
    """Write one external record into the CRM. Returns an outcome code (never raises for record problems)."""
    policy = policy_for(connection, entity_type)
    if policy is None or policy.direction not in INBOUND:
        return "not_shared"
    spec = fields.entity(entity_type)
    actor = require_actor(connection)
    mappings = mappings_for(connection, entity_type)
    values = fields.inbound_values(entity_type, external.values, mappings)
    if not values:
        return "nothing_mapped"
    external_hash = fields.stable_hash(values)
    bind = binding(entity_type)
    record_map = (
        IntegrationRecordMap.objects.select_for_update()
        .filter(connection=connection, entity_type=entity_type, external_record_id=external.external_id)
        .first()
    )
    record = None
    if record_map is not None:
        record = (
            scope(actor, _view_permission(entity_type), bind.model.objects.filter(pk=record_map.crm_record_id))
            .select_related(*bind.select_related)
            .first()
        )
        if record is None:
            return "not_visible"
        if record.archived_at is not None:
            return "archived"
        if record_map.last_external_hash == external_hash:
            return "unchanged"
        crm_changed = record.version != record_map.last_synced_version
        if crm_changed and policy.direction == Direction.TWO_WAY:
            differing = [f for f, v in values.items() if _differs(record, f, v)]
            if differing and not _external_wins(connection, record, external):
                if connection.conflict_strategy == ConflictStrategy.CRM_WINS or (
                    connection.conflict_strategy == ConflictStrategy.NEWEST_WINS and external.updated_at is not None
                ):
                    record_map.last_external_hash = external_hash
                    record_map.save(update_fields=["last_external_hash", "updated_at"])
                    return "kept_crm"
                _open_conflict(connection, entity_type, record, external.external_id, values, differing)
                return "conflict"
    elif not spec.inbound_create:
        return "create_not_allowed"

    try:
        with (
            transaction.atomic(),
            events.inbound_origin(connection.pk),
            audit.acting_integration("connection", connection.pk),
        ):
            saved = _write(actor, entity_type, record, values)
            outbound_hash = ""
            if policy.direction == Direction.TWO_WAY:
                saved_full = bind.model.objects.select_related(*bind.select_related).get(pk=saved.pk)
                outbound_hash = fields.stable_hash(fields.outbound_values(entity_type, saved_full, mappings))
            IntegrationRecordMap.objects.update_or_create(
                connection=connection,
                entity_type=entity_type,
                external_record_id=external.external_id,
                defaults={
                    "crm_record_id": saved.pk,
                    "last_synced_version": saved.version,
                    "last_external_hash": external_hash,
                    "last_crm_hash": outbound_hash,
                    "last_synced_at": timezone.now(),
                },
            )
    except ValidationError:
        return "validation_failed"
    except (PermissionDenied, DomainError):
        return "permission_denied"
    except IntegrityError:
        return "duplicate"
    return "updated" if record is not None else "created"


def _external_wins(connection: IntegrationConnection, record: Any, external: ExternalRecord) -> bool:
    if connection.conflict_strategy == ConflictStrategy.EXTERNAL_WINS:
        return True
    if connection.conflict_strategy == ConflictStrategy.NEWEST_WINS and external.updated_at is not None:
        return external.updated_at > record.updated_at
    return False


def _open_conflict(
    connection: IntegrationConnection,
    entity_type: str,
    record: Any,
    external_id: str,
    values: dict[str, Any],
    differing: list[str],
) -> None:
    SyncConflict.objects.update_or_create(
        connection=connection,
        entity_type=entity_type,
        crm_record_id=record.pk,
        status=SyncConflict.Status.OPEN,
        defaults={"external_record_id": external_id, "fields": sorted(differing), "external_values": values},
    )


def resolve_conflict(
    actor_membership_actor, conflict: SyncConflict, *, resolution: str, request: Any = None
) -> SyncConflict:
    """``keep_crm``: leave the record and push it on the next sync. ``apply_external``: write the stored values."""
    from apps.authz.service import check

    check(actor_membership_actor, "integrations.manage")
    if conflict.status != SyncConflict.Status.OPEN:
        raise DomainError("This conflict was already resolved.", code="conflict_resolved", status_code=409)
    connection = conflict.connection
    record_map = IntegrationRecordMap.objects.filter(
        connection=connection, entity_type=conflict.entity_type, crm_record_id=conflict.crm_record_id
    ).first()
    if resolution == "apply_external":
        actor = require_actor(connection)
        bind = binding(conflict.entity_type)
        record = scope(
            actor, _view_permission(conflict.entity_type), bind.model.objects.filter(pk=conflict.crm_record_id)
        ).first()
        if record is None:
            raise DomainError("The record is no longer available.", code="record_unavailable", status_code=409)
        with events.inbound_origin(connection.pk), audit.acting_integration("connection", connection.pk):
            saved = _write(actor, conflict.entity_type, record, conflict.external_values)
        if record_map is not None:
            record_map.last_synced_version = saved.version
            record_map.last_external_hash = fields.stable_hash(conflict.external_values)
            record_map.last_synced_at = timezone.now()
            record_map.save(update_fields=["last_synced_version", "last_external_hash", "last_synced_at", "updated_at"])
        conflict.status = SyncConflict.Status.APPLIED_EXTERNAL
    elif resolution == "keep_crm":
        if record_map is not None:
            record_map.last_external_hash = fields.stable_hash(conflict.external_values)
            record_map.save(update_fields=["last_external_hash", "updated_at"])
        conflict.status = SyncConflict.Status.KEPT_CRM
    else:
        raise ValidationError({"resolution": "Choose keep_crm or apply_external."})
    conflict.resolved_by = actor_membership_actor.membership
    conflict.resolved_at = timezone.now()
    conflict.external_values = {}  # the decision is made: do not keep the external copy
    conflict.save(update_fields=["status", "resolved_by", "resolved_at", "external_values", "updated_at"])
    audit.record(
        audit_actions.INTEGRATION_CONFLICT_RESOLVED,
        request=request,
        user=actor_membership_actor.user,
        resource=conflict,
        resource_type="sync_conflict",
        metadata={"connection_id": str(connection.pk), "resolution": resolution, "fields": conflict.fields},
    )
    return conflict


# ----------------------------------------------------------------------------- batch jobs


def _job_error(job: SyncJob, entity_type: str, record_id: Any, code: str) -> None:
    job.failed += 1
    job.errors = [
        *job.errors[-(MAX_JOB_ERRORS - 1) :],
        {"entity_type": entity_type, "record_id": str(record_id), "code": code},
    ]


def run_job_batch(job: SyncJob) -> bool:
    """Process one batch. Returns True when more work remains (the task re-enqueues itself).

    State machine in ``job.state``: phase "push" walks CRM records per outbound entity by primary key;
    phase "pull" pages through the provider per inbound entity. Each call does at most
    ``INTEGRATIONS_SYNC_BATCH_SIZE`` records so one job never monopolizes a worker.
    """
    connection = job.connection
    batch_size = settings.INTEGRATIONS_SYNC_BATCH_SIZE
    state = dict(job.state or {})
    phase = state.get("phase", "push")
    policies = list(
        SharingPolicy.objects.filter(connection=connection).exclude(direction=Direction.NONE).order_by("entity_type")
    )
    provider = get_provider(connection.provider)
    actor = require_actor(connection)

    if phase == "push":
        outbound = [p for p in policies if p.direction in OUTBOUND and fields.ENTITIES[p.entity_type].shareable]
        index = int(state.get("entity_index", 0))
        if index >= len(outbound):
            job.state = {"phase": "pull", "entity_index": 0}
            return True
        policy = outbound[index]
        bind = binding(policy.entity_type)
        qs = scope(actor, _view_permission(policy.entity_type), bind.model.objects.filter(archived_at__isnull=True))
        if state.get("last_id"):
            qs = qs.filter(pk__gt=state["last_id"])
        ids = list(qs.order_by("pk").values_list("pk", flat=True)[:batch_size])
        for record_id in ids:
            job.processed += 1
            try:
                outcome = push_record(connection, policy.entity_type, record_id)
            except ProviderError as exc:
                if exc.action_required or exc.retryable:
                    raise
                _job_error(job, policy.entity_type, record_id, exc.code)
                continue
            if outcome in ("pushed", "unchanged"):
                job.succeeded += 1
        if len(ids) < batch_size:
            job.state = {"phase": "push", "entity_index": index + 1}
        else:
            job.state = {"phase": "push", "entity_index": index, "last_id": str(ids[-1])}
        return True

    inbound = [p for p in policies if p.direction in INBOUND and fields.ENTITIES[p.entity_type].shareable]
    index = int(state.get("entity_index", 0))
    if index >= len(inbound) or not provider.supports_sync:
        return False
    policy = inbound[index]
    ctx = provider_context(connection)
    since = connection.last_success_at if not state.get("cursor") else None
    page = provider.pull(
        ctx, policy.entity_type, resource=policy.external_resource, cursor=state.get("cursor"), since=since
    )
    for external in page.records[:batch_size]:
        job.processed += 1
        outcome = apply_inbound(connection, policy.entity_type, external)
        if outcome in ("created", "updated", "unchanged", "kept_crm"):
            job.succeeded += 1
        elif outcome == "conflict":
            job.conflicts += 1
        elif outcome not in ("not_shared", "nothing_mapped", "archived"):
            _job_error(job, policy.entity_type, external.external_id, outcome)
    if page.next_cursor and page.records:
        job.state = {"phase": "pull", "entity_index": index, "cursor": page.next_cursor}
    else:
        job.state = {"phase": "pull", "entity_index": index + 1}
    return True


def finish_job(job: SyncJob, *, error: ProviderError | None = None) -> None:
    now = timezone.now()
    connection = job.connection
    job.finished_at = now
    if error is None:
        job.status = SyncJob.Status.COMPLETED
        record_success(connection, synced=True)
        action = audit_actions.INTEGRATION_SYNC_COMPLETED
    else:
        job.status = SyncJob.Status.FAILED
        job.error_code = error.code[:64]
        record_failure(connection, error)
        action = audit_actions.INTEGRATION_SYNC_FAILED
    if connection.sync_interval_minutes:
        IntegrationConnection.objects.filter(pk=connection.pk).update(
            next_sync_at=now + dt.timedelta(minutes=connection.sync_interval_minutes)
        )
    job.save()
    audit.record(
        action,
        organization_id=job.organization_id,
        actor_type="integration",
        resource=job,
        resource_type="sync_job",
        metadata={
            "connection_id": str(connection.pk),
            "processed": job.processed,
            "succeeded": job.succeeded,
            "failed": job.failed,
            "conflicts": job.conflicts,
            "error_code": job.error_code,
        },
    )
