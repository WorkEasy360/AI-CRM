import pytest
from django.db import DatabaseError, transaction

from apps.audit import service as audit
from apps.audit.models import AuditEvent
from apps.core.tenancy.context import system_context, tenant_context

pytestmark = pytest.mark.django_db


def test_audit_rows_are_append_only(org_a):
    with tenant_context(org_a.org.pk):
        event = audit.record("test.event", organization_id=org_a.org.pk)
        with pytest.raises(DatabaseError), transaction.atomic():
            AuditEvent.objects.filter(pk=event.pk).update(action="tampered")
        with pytest.raises(DatabaseError), transaction.atomic():
            AuditEvent.objects.filter(pk=event.pk).delete()
        assert AuditEvent.objects.get(pk=event.pk).action == "test.event"


def test_secrets_are_redacted(org_a):
    with tenant_context(org_a.org.pk):
        event = audit.record(
            "test.event",
            metadata={"password": "hunter2", "nested": {"token": "abc", "ok": "fine"}, "long": "x" * 2000},
        )
    assert event.metadata["password"] == "[redacted]"
    assert event.metadata["nested"]["token"] == "[redacted]"
    assert event.metadata["nested"]["ok"] == "fine"
    assert len(event.metadata["long"]) < 600


def test_audit_is_tenant_scoped(org_a, org_b):
    with tenant_context(org_b.org.pk):
        audit.record("test.b", organization_id=org_b.org.pk)
    with tenant_context(org_a.org.pk):
        assert not AuditEvent.objects.filter(action="test.b").exists()
    with system_context("test"):
        assert AuditEvent.objects.filter(action="test.b").exists()


def test_audit_api_lists_and_filters(org_a, owner_client, make_member):
    make_member(org_a)
    resp = owner_client.get("/api/v1/audit-events/?action=org.created")
    assert resp.status_code == 200
    assert all(r["action"] == "org.created" for r in resp.json()["results"])
    assert resp.json()["results"], "org.created should have been audited"
    assert owner_client.get("/api/v1/audit-events/?since=not-a-date").status_code == 400
