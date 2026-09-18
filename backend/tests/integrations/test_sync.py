"""Synchronization: least-data outbound pushes, validated inbound writes, conflicts, jobs, isolation."""

from __future__ import annotations

import httpx
import pytest
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.accounts.models import Membership
from apps.authz.models import Role
from apps.contacts.models import Contact
from apps.core.tenancy.context import tenant_context
from apps.integrations import delivery, events, fields, sync
from apps.integrations.models import (
    ConflictStrategy,
    ConnectionStatus,
    Direction,
    FieldMapping,
    IntegrationConnection,
    IntegrationEvent,
    IntegrationRecordMap,
    OutboundDelivery,
    SharingPolicy,
    SyncConflict,
    SyncJob,
)
from apps.integrations.providers.base import ExternalRecord, ProviderError
from apps.notifications.models import Notification
from tests.integrations.conftest import json_body

pytestmark = pytest.mark.security


def _ctx(org):
    return tenant_context(org.org.pk, reason="test.sync")


# ----------------------------------------------------------------------------- allowlist / denylist


@pytest.mark.parametrize(
    "crm_field",
    [
        "password",
        "password_hash",
        "session_salt",
        "mfa_secret",
        "api_key",
        "access_token_enc",
        "owner_id",
        "description",
        "notes",
        "search_vector",
    ],
)
def test_security_and_unlisted_fields_can_never_be_mapped(org_a, crm_field):
    with _ctx(org_a), pytest.raises(ValidationError):
        fields.validate_mappings("contact", "outbound", [{"crm_field": crm_field, "external_field": "x"}])


def test_custom_fields_with_sensitive_names_are_excluded(org_a, crm):
    crm.make_custom_field(org_a, entity_type="contact", key="api_token", label="API token")
    crm.make_custom_field(org_a, entity_type="contact", key="industry_code", label="Industry code")
    with _ctx(org_a):
        allowed = fields.allowed_fields("contact", direction="outbound")
        assert "custom.industry_code" in allowed and "custom.api_token" not in allowed
        with pytest.raises(ValidationError):
            fields.validate_mappings("contact", "outbound", [{"crm_field": "custom.api_token", "external_field": "t"}])


@pytest.mark.parametrize("entity", ["note", "email", "whatsapp", "attachment", "user", "membership"])
def test_prohibited_data_types_cannot_be_shared(org_a, entity):
    with _ctx(org_a), pytest.raises(ValidationError):
        fields.validate_mappings(entity, "outbound", [{"crm_field": "id", "external_field": "id"}])


def test_outbound_values_recheck_allowlist_even_if_a_bad_mapping_row_exists(org_a, crm, connection):
    contact = crm.make_contact(
        org_a, first_name="Ada", last_name="", email="ada@example.com", description="secret plans"
    )
    with _ctx(org_a):
        # A row written behind the service's back (e.g. directly in the DB) still cannot leak data.
        FieldMapping.objects.create(
            connection=connection, entity_type="contact", crm_field="description", external_field="notes"
        )
        values = fields.outbound_values("contact", contact, sync.mappings_for(connection, "contact"))
    assert values == {"firstName": "Ada", "lastName": "", "emailAddress": "ada@example.com"}


# ----------------------------------------------------------------------------- outbound


def test_push_sends_only_mapped_fields_and_is_idempotent(org_a, crm, connection, remote):
    remote.on("POST", "/v1/contacts", 201, {"id": "ext-1"})
    remote.on("PATCH", "/v1/contacts/ext-1", 200, {"id": "ext-1"})
    contact = crm.make_contact(org_a, first_name="Ada", last_name="L", email="ada@example.com", phone="+911234567890")
    with _ctx(org_a):
        assert sync.push_record(connection, "contact", contact.pk) == "pushed"
        assert sync.push_record(connection, "contact", contact.pk) == "unchanged"
        record_map = IntegrationRecordMap.objects.get(connection=connection, crm_record_id=contact.pk)
    create = remote.calls("POST", "/v1/contacts")
    assert len(create) == 1
    assert json_body(create[0]) == {"firstName": "Ada", "lastName": "L", "emailAddress": "ada@example.com"}
    assert create[0].headers["x-api-key"] == "test-api-key"
    assert create[0].headers["idempotency-key"]
    assert record_map.external_record_id == "ext-1"

    with _ctx(org_a):
        Contact.objects.filter(pk=contact.pk).update(first_name="Ada2", version=contact.version + 1)
        assert sync.push_record(connection, "contact", contact.pk) == "pushed"
    assert json_body(remote.calls("PATCH", "/v1/contacts/ext-1")[0])["firstName"] == "Ada2"


def test_push_of_another_tenants_record_is_impossible(org_a, org_b, crm, connection, remote):
    foreign = crm.make_contact(org_b, first_name="Bob", email="bob@example.com")
    with _ctx(org_a):
        assert sync.push_record(connection, "contact", foreign.pk) == "not_visible"
    assert remote.requests == []


def test_nothing_is_pushed_for_entities_without_outbound_policy(org_a, crm, connection, remote):
    company = crm.make_company(org_a, name="Acme")
    with _ctx(org_a):
        assert sync.push_record(connection, "company", company.pk) == "not_shared"
    assert remote.requests == []


def test_crm_save_goes_through_outbox_to_provider(org_a, crm, connection, remote, django_capture_on_commit_callbacks):
    remote.on("POST", "/v1/contacts", 201, {"id": "ext-9"})
    events.invalidate_targets(org_a.org.pk)
    contact = crm.make_contact(org_a, first_name="Ada", email="ada@example.com")
    with _ctx(org_a):
        event = IntegrationEvent.objects.get(entity_id=contact.pk, event_type="contact.created")
        (row,) = delivery.dispatch(event)
        assert row.connection_id == connection.pk
        assert delivery.attempt(row) == OutboundDelivery.Status.SUCCEEDED
    assert len(remote.calls("POST", "/v1/contacts")) == 1


def test_inbound_writes_are_not_echoed_back_to_their_connection(org_a, crm, connection, remote):
    events.invalidate_targets(org_a.org.pk)
    with _ctx(org_a):
        outcome = sync.apply_inbound(
            connection,
            "contact",
            ExternalRecord("ext-5", {"id": "ext-5", "firstName": "Zed", "emailAddress": "z@example.com"}),
        )
        assert outcome == "created"
        event = IntegrationEvent.objects.get(event_type="contact.created")
        assert event.origin_connection_id == connection.pk
        assert delivery.dispatch(event) == []
    assert remote.requests == []


def test_member_losing_access_stops_the_integration(org_a, crm, connection, remote, make_member):
    admin = make_member(org_a, "admin")
    with _ctx(org_a):
        IntegrationConnection.objects.filter(pk=connection.pk).update(connected_by=admin)
        connection.refresh_from_db()
        admin.role = Role.objects.get(key="sales_rep", is_system=True, organization__isnull=True)
        admin.save(update_fields=["role"])
    contact = crm.make_contact(org_a)
    with _ctx(org_a):
        with pytest.raises(ProviderError) as exc:
            sync.push_record(connection, "contact", contact.pk)
        assert exc.value.code == "member_lost_access"
        Membership.objects.filter(pk=admin.pk).update(status="disabled")
        assert sync.connection_actor(connection) is None
    assert remote.requests == []


def test_expired_provider_auth_marks_action_required_and_notifies_admins(org_a, crm, connection, remote):
    remote.on("POST", "/v1/contacts", 401, {"error": "invalid_grant"})
    events.invalidate_targets(org_a.org.pk)
    contact = crm.make_contact(org_a)
    with _ctx(org_a):
        event = IntegrationEvent.objects.get(entity_id=contact.pk)
        (row,) = delivery.dispatch(event)
        assert delivery.attempt(row) == OutboundDelivery.Status.FAILED
        connection.refresh_from_db()
        assert connection.status == ConnectionStatus.ACTION_REQUIRED
        assert connection.last_error_code == "auth_expired"
        note = Notification.objects.get(kind="integration_alert", entity_id=connection.pk)
    assert "expired" in note.body and "invalid_grant" not in note.body


# ----------------------------------------------------------------------------- inbound + conflicts


def _inbound(connection, external_id, **values):
    return sync.apply_inbound(connection, "contact", ExternalRecord(external_id, {"id": external_id, **values}))


def test_inbound_validation_uses_crm_rules(org_a, connection):
    with _ctx(org_a):
        assert _inbound(connection, "bad", emailAddress="not-an-email") == "validation_failed"
        assert _inbound(connection, "empty", firstName="") == "validation_failed"  # contact needs an identity
        assert not Contact.objects.exists()


def test_inbound_without_inbound_policy_writes_nothing(org_a, connection):
    with _ctx(org_a):
        SharingPolicy.objects.filter(connection=connection).update(direction=Direction.OUTBOUND)
        assert _inbound(connection, "x", firstName="No") == "not_shared"
        assert not Contact.objects.exists()


@pytest.mark.parametrize(
    ("strategy", "outcome", "expected_name"),
    [
        (ConflictStrategy.MANUAL, "conflict", "CRM edit"),
        (ConflictStrategy.CRM_WINS, "kept_crm", "CRM edit"),
        (ConflictStrategy.EXTERNAL_WINS, "updated", "External edit"),
    ],
)
def test_two_way_conflicts_follow_strategy(org_a, connection, strategy, outcome, expected_name):
    with _ctx(org_a):
        IntegrationConnection.objects.filter(pk=connection.pk).update(conflict_strategy=strategy)
        connection.refresh_from_db()
        assert _inbound(connection, "ext-c", firstName="Original", emailAddress="c@example.com") == "created"
        contact = Contact.objects.get(email="c@example.com")
        # both sides change the same field
        Contact.objects.filter(pk=contact.pk).update(first_name="CRM edit", version=contact.version + 1)
        assert _inbound(connection, "ext-c", firstName="External edit", emailAddress="c@example.com") == outcome
        contact.refresh_from_db()
        assert contact.first_name == expected_name
        if strategy == ConflictStrategy.MANUAL:
            conflict = SyncConflict.objects.get(connection=connection, status="open")
            assert conflict.fields == ["first_name"]
            assert conflict.external_values["first_name"] == "External edit"


def test_newest_update_wins(org_a, connection):
    with _ctx(org_a):
        IntegrationConnection.objects.filter(pk=connection.pk).update(conflict_strategy=ConflictStrategy.NEWEST_WINS)
        connection.refresh_from_db()
        _inbound(connection, "ext-n", firstName="One", emailAddress="n@example.com")
        contact = Contact.objects.get(email="n@example.com")
        Contact.objects.filter(pk=contact.pk).update(first_name="CRM", version=contact.version + 1)
        older = ExternalRecord(
            "ext-n",
            {"id": "ext-n", "firstName": "Old", "emailAddress": "n@example.com"},
            updated_at=timezone.now() - timezone.timedelta(days=1),
        )
        assert sync.apply_inbound(connection, "contact", older) == "kept_crm"
        newer = ExternalRecord(
            "ext-n",
            {"id": "ext-n", "firstName": "New", "emailAddress": "n@example.com"},
            updated_at=timezone.now() + timezone.timedelta(minutes=5),
        )
        assert sync.apply_inbound(connection, "contact", newer) == "updated"
        contact.refresh_from_db()
        assert contact.first_name == "New"


def test_manual_conflict_resolution_via_api(org_a, owner_client, connection):
    with _ctx(org_a):
        _inbound(connection, "ext-r", firstName="A", emailAddress="r@example.com")
        contact = Contact.objects.get(email="r@example.com")
        Contact.objects.filter(pk=contact.pk).update(first_name="CRM", version=contact.version + 1)
        assert _inbound(connection, "ext-r", firstName="EXT", emailAddress="r@example.com") == "conflict"
        conflict = SyncConflict.objects.get(status="open")
    listed = owner_client.get(f"/api/v1/integrations/connections/{connection.pk}/conflicts/").json()["results"]
    assert [c["id"] for c in listed] == [str(conflict.pk)]
    resp = owner_client.post(
        f"/api/v1/integrations/connections/{connection.pk}/conflicts/{conflict.pk}/resolve/",
        {"resolution": "apply_external"},
        format="json",
    )
    assert resp.status_code == 200 and resp.json()["status"] == "applied_external"
    assert resp.json()["external_values"] == {}
    with _ctx(org_a):
        contact.refresh_from_db()
    assert contact.first_name == "EXT"


# ----------------------------------------------------------------------------- batch jobs


def test_sync_job_pushes_and_pulls_in_batches(org_a, crm, connection, remote, settings, owner_client):
    settings.INTEGRATIONS_SYNC_BATCH_SIZE = 2
    counter = iter(range(100))
    remote.handle("POST", "/v1/contacts", lambda r: httpx.Response(201, json={"id": f"new-{next(counter)}"}))
    remote.on(
        "GET",
        "/v1/contacts",
        200,
        {
            "data": [{"id": "remote-1", "firstName": "Remote", "emailAddress": "remote@example.com"}],
            "next_cursor": None,
        },
    )
    for i in range(5):
        crm.make_contact(org_a, first_name=f"C{i}", email=f"c{i}@example.com")
    resp = owner_client.post(f"/api/v1/integrations/connections/{connection.pk}/sync/", {}, format="json")
    assert resp.status_code == 202, resp.content
    job_id = resp.json()["id"]
    from apps.integrations import tasks

    with _ctx(org_a):
        for _ in range(20):  # run the batches the task would chain
            if SyncJob.objects.get(pk=job_id).status not in ("pending", "processing"):
                break
            tasks.run_sync_job.run(job_id=job_id, organization_id=org_a.org.pk)
        job = SyncJob.objects.get(pk=job_id)
        connection.refresh_from_db()
    assert job.status == "completed", job.errors
    assert job.processed == 6 and job.succeeded == 6 and job.failed == 0
    assert len(remote.calls("POST", "/v1/contacts")) == 5
    assert connection.status == ConnectionStatus.CONNECTED and connection.last_success_at is not None
    with _ctx(org_a):
        assert Contact.objects.filter(email="remote@example.com").exists()
    detail = owner_client.get(f"/api/v1/integrations/connections/{connection.pk}/").json()
    assert detail["latest_job"]["status"] == "completed"


@pytest.mark.parametrize(
    "body",
    [b"<html>not json</html>", b'{"data": "nope"}', b'{"data": [' + b'{"id": 1},' * 600 + b'{"id": 2}]}'],
)
def test_malformed_provider_response_fails_cleanly(org_a, connection, remote, body):
    remote.handle("GET", "/v1/contacts", lambda r: httpx.Response(200, content=body))
    from apps.integrations.providers import get_provider

    with _ctx(org_a), pytest.raises(ProviderError) as exc:
        get_provider("generic_rest").pull(
            sync.provider_context(connection), "contact", resource="/contacts", cursor=None, since=None
        )
    assert exc.value.code == "invalid_response"


def test_sync_rejected_when_nothing_shared_or_already_running(org_a, owner_client, connection):
    with _ctx(org_a):
        SyncJob.objects.create(connection=connection, status="processing")
    assert (
        owner_client.post(f"/api/v1/integrations/connections/{connection.pk}/sync/", {}, format="json").status_code
        == 409
    )
    with _ctx(org_a):
        SyncJob.objects.all().delete()
        SharingPolicy.objects.filter(connection=connection).update(direction=Direction.NONE)
    resp = owner_client.post(f"/api/v1/integrations/connections/{connection.pk}/sync/", {}, format="json")
    assert resp.status_code == 409 and resp.json()["type"] == "nothing_shared"
