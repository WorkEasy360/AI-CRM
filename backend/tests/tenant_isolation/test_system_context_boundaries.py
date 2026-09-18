"""The reviewed ``all_objects`` exceptions must stay lookups, and the boundary must close behind them.

Every remaining use of ``all_objects`` carries a line-level ``nosemgrep`` for
``keel-unscoped-manager-outside-system-code``. Semgrep can only check that the suppression is there;
these tests check what it claims. For each one: the system context covers the lookup and nothing
more, the work itself happens inside the organization that owns the row, and no context is left
bound once the call returns.
"""

import uuid

import pytest

from apps.core.tenancy.context import get_context, system_context, tenant_context
from apps.importexport import tasks as importexport_tasks
from apps.integrations import tasks as integration_tasks
from apps.integrations.machine_auth import authenticate_key
from apps.integrations.models import ApiCredential
from apps.rag import tasks as rag_tasks
from apps.rag.models import IndexEvent, IndexStatus, KnowledgeChunk, SourceType

pytestmark = [pytest.mark.django_db, pytest.mark.security]


def _issue_credential(client, reauthenticate, scopes=("contacts:read",)) -> tuple[str, uuid.UUID]:
    """Create an API credential the normal way and return (raw key, credential pk)."""
    reauthenticate(client)
    resp = client.post(
        "/api/v1/integrations/api-credentials/",
        {"name": "Sweeper test", "scopes": list(scopes)},
        format="json",
    )
    assert resp.status_code == 201, resp.content
    key = resp.json()["key"]
    prefix = key.split("_")[1]
    with system_context("test.locate_credential"):
        pk = ApiCredential.all_objects.filter(prefix=prefix).values_list("pk", flat=True).first()
    assert pk is not None
    return key, pk


# --------------------------------------------------------------------- machine credential lookup


def test_authenticate_key_binds_the_credentials_own_tenant_and_unbinds_it(org_a, owner_client, reauthenticate):
    key, _ = _issue_credential(owner_client, reauthenticate)
    assert get_context() is None
    actor = authenticate_key(key)
    assert actor is not None
    assert actor.organization.pk == org_a.org.pk
    # The privileged lookup is over: nothing stays bound for the rest of the request.
    assert get_context() is None


def test_machine_credential_whose_creator_sits_in_another_organization_is_refused(
    org_a, org_b, owner_client, reauthenticate
):
    """A credential row pointing at a foreign membership must not authenticate as that member.

    This is the shape a mis-issued or tampered credential has. The membership is resolved inside the
    credential's *own* organization, so a ``created_by`` from another tenant simply is not found and
    the credential fails closed instead of borrowing the foreign member's grants.
    """
    key, credential_pk = _issue_credential(owner_client, reauthenticate)
    assert authenticate_key(key) is not None

    with system_context("test.mismap_credential"):
        ApiCredential.all_objects.filter(pk=credential_pk).update(created_by_id=org_b.owner_membership.pk)

    assert authenticate_key(key) is None
    assert get_context() is None


# ------------------------------------------------------------------------------- system sweepers


def _seed_index_events(*bundles) -> dict[str, str]:
    seeded = {}
    for bundle in bundles:
        with tenant_context(bundle.org.pk, reason="test.seed_index_event"):
            event = IndexEvent.objects.create(
                source_type=SourceType.NOTE, source_id=uuid.uuid4(), status=IndexStatus.PENDING
            )
            seeded[str(bundle.org.pk)] = str(event.source_id)
    return seeded


def test_rag_sweeper_discovers_across_tenants_but_hands_each_row_to_its_own_organization(org_a, org_b, monkeypatch):
    seeded = _seed_index_events(org_a, org_b)
    dispatched: list[dict] = []
    monkeypatch.setattr(rag_tasks.index_source, "delay", lambda **kw: dispatched.append(kw))

    assert get_context() is None
    rag_tasks.drain_pending()
    assert get_context() is None

    ours = [d for d in dispatched if d["organization_id"] in seeded]
    assert {d["organization_id"] for d in ours} == set(seeded)
    # Each job carries its own row's organization: one tenant's sweep never widens into another's.
    for job in ours:
        assert job["source_id"] == seeded[job["organization_id"]]


def test_integration_and_import_sweepers_leave_no_context_bound(org_a, org_b, monkeypatch):
    for task in (
        integration_tasks.dispatch_event,
        integration_tasks.deliver,
        integration_tasks.run_sync_job,
        integration_tasks.schedule_sync,
    ):
        monkeypatch.setattr(task, "delay", lambda **kw: None)
    monkeypatch.setattr(importexport_tasks.run_import, "apply_async", lambda **kw: None)

    assert get_context() is None
    integration_tasks.drain()
    assert get_context() is None
    importexport_tasks.resume_stalled_imports()
    assert get_context() is None


def test_the_sweepers_unscoped_reads_still_need_a_system_context(org_a):
    """The exception is the ``system_context`` block, not the model: outside it the manager refuses."""
    from apps.core.exceptions import UnscopedAccessError
    from apps.integrations.models import IntegrationConnection, SyncJob

    for model in (IndexEvent, SyncJob, IntegrationConnection, ApiCredential):
        with pytest.raises(UnscopedAccessError):
            model.all_objects.count()
        with tenant_context(org_a.org.pk, reason="test.scoped"), pytest.raises(UnscopedAccessError):
            model.all_objects.count()


# ------------------------------------------------------------------- cross-tenant job / RAG attack


def test_a_forged_organization_id_on_an_index_job_indexes_nothing_of_the_other_tenant(org_a, org_b, crm):
    """Org A's worker handed org B's record id must not index it into either organization."""
    note = crm.make_note(org_b, body="Org B confidential pricing")

    rag_tasks.index_source(organization_id=str(org_a.org.pk), source_type=SourceType.NOTE, source_id=str(note.pk))

    with tenant_context(org_a.org.pk, reason="test.assert"):
        assert not KnowledgeChunk.objects.filter(source_id=note.pk).exists()
    assert get_context() is None
