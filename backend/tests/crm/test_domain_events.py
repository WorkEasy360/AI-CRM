"""Regression tests for the writes that used to change the database silently.

Every path here is a ``QuerySet.update()``: Django emits no model signal for one, so before
``apps.core.domain_events`` existed the row changed while the integration outbox, the knowledge index
and the dashboard cache all carried on as if nothing had happened. Each test asserts the outbox rows
that a bulk write must now produce, and that it produces them *once*.
"""

from __future__ import annotations

import uuid

import pytest

from apps.core.tenancy.context import tenant_context
from apps.integrations.models import IntegrationEvent, WebhookSubscription
from apps.lifecycle.models import LifecycleHistory
from apps.rag.models import IndexEvent, KnowledgeChunk

pytestmark = pytest.mark.django_db

ALL_EVENTS = [
    "contact.created",
    "contact.updated",
    "company.created",
    "company.updated",
    "deal.created",
    "deal.updated",
    "deal.stage_changed",
    "task.completed",
]


@pytest.fixture
def subscribed(org_a):
    """An active webhook subscribed to every event type, so the outbox records all of them.

    Created directly rather than through the API: creating one over HTTP resolves the URL (SSRF
    guard), and what is under test here is which events reach the outbox, not webhook validation.
    """
    from apps.core import crypto
    from apps.integrations.events import invalidate_targets

    with tenant_context(org_a.org.pk):
        subscription = WebhookSubscription.objects.create(
            name="All events",
            url="https://hooks.example.com/keel",
            event_types=ALL_EVENTS,
            secret_enc=crypto.encrypt("whsec_test"),
            status=WebhookSubscription.Status.ACTIVE,
        )
    invalidate_targets(org_a.org.pk)
    return subscription


def _events(org, entity_id, event_type=None) -> list[str]:
    with tenant_context(org.org.pk):
        qs = IntegrationEvent.objects.filter(entity_id=entity_id)
        if event_type:
            qs = qs.filter(event_type=event_type)
        return list(qs.values_list("event_type", flat=True))


def _index_events(org, entity_id) -> list[IndexEvent]:
    with tenant_context(org.org.pk):
        return list(IndexEvent.objects.filter(source_id=entity_id))


def _clear_outboxes(org):
    """Forget the events created by setup, so each test asserts only on the write under test."""
    with tenant_context(org.org.pk):
        IntegrationEvent.objects.all().delete()
        IndexEvent.objects.all().delete()


# --------------------------------------------------------------------------- bulk archive / restore


def test_bulk_archive_emits_update_event_and_reindexes(org_a, owner_client, crm, subscribed):
    contacts = [crm.make_contact(org_a) for _ in range(3)]
    _clear_outboxes(org_a)

    resp = owner_client.post(
        "/api/v1/contacts/bulk/",
        {"ids": [str(c.pk) for c in contacts], "action": "archive"},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert resp.json()["affected"] == 3

    for contact in contacts:
        assert _events(org_a, contact.pk) == ["contact.updated"]
        assert len(_index_events(org_a, contact.pk)) == 1


def test_bulk_restore_emits_update_event(org_a, owner_client, crm, subscribed):
    contacts = [crm.make_contact(org_a) for _ in range(2)]
    ids = [str(c.pk) for c in contacts]
    owner_client.post("/api/v1/contacts/bulk/", {"ids": ids, "action": "archive"}, format="json")
    _clear_outboxes(org_a)

    resp = owner_client.post("/api/v1/contacts/bulk/", {"ids": ids, "action": "restore"}, format="json")
    assert resp.status_code == 200, resp.content

    for contact in contacts:
        assert _events(org_a, contact.pk) == ["contact.updated"]


# --------------------------------------------------------------------------- bulk reassign


def test_bulk_reassign_emits_event_and_refreshes_the_rag_owner(org_a, owner_client, crm, subscribed, make_member):
    """The reassignment is the one that mattered most: the retrieval pre-filter keys off this owner."""
    member = make_member(org_a, "sales_rep")
    contact = crm.make_contact(org_a)
    with tenant_context(org_a.org.pk):
        KnowledgeChunk.objects.create(
            source_type="contact",
            source_id=contact.pk,
            chunk_index=0,
            content="Grace prefers email.",
            content_hash="0" * 64,
            entity_type="contact",
            entity_id=contact.pk,
            entity_owner_id=org_a.owner_membership.pk,
        )
    _clear_outboxes(org_a)

    resp = owner_client.post(
        "/api/v1/contacts/bulk/",
        {"ids": [str(contact.pk)], "action": "reassign", "payload": {"owner_id": str(member.pk)}},
        format="json",
    )
    assert resp.status_code == 200, resp.content

    assert _events(org_a, contact.pk) == ["contact.updated"]
    with tenant_context(org_a.org.pk):
        chunk = KnowledgeChunk.objects.get(entity_id=contact.pk)
        assert chunk.entity_owner_id == member.pk


def test_bulk_tagging_emits_an_update_event(org_a, owner_client, crm, subscribed):
    contact = crm.make_contact(org_a)
    tag = crm.make_tag(org_a)
    _clear_outboxes(org_a)

    resp = owner_client.post(
        "/api/v1/contacts/bulk/",
        {"ids": [str(contact.pk)], "action": "add_tag", "payload": {"tag_id": str(tag.pk)}},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert _events(org_a, contact.pk) == ["contact.updated"]


# --------------------------------------------------------------------------- deal stage move


def test_stage_change_emits_stage_changed_and_updated(org_a, owner_client, crm, subscribed):
    """``deal.stage_changed`` is the headline pipeline event and used to be emitted by nothing."""
    deal = crm.make_deal(org_a)
    with tenant_context(org_a.org.pk):
        from apps.pipelines.models import PipelineStage

        target = (
            PipelineStage.objects.filter(pipeline_id=deal.pipeline_id, archived_at__isnull=True)
            .exclude(pk=deal.stage_id)
            .first()
        )
        assert target is not None
        version = deal.version
    _clear_outboxes(org_a)

    resp = owner_client.post(
        f"/api/v1/deals/{deal.pk}/stage/",
        {"stage_id": str(target.pk), "version": version},
        format="json",
    )
    assert resp.status_code == 200, resp.content

    emitted = sorted(_events(org_a, deal.pk))
    assert emitted == ["deal.stage_changed", "deal.updated"]
    assert len(_index_events(org_a, deal.pk)) == 1


def test_stage_change_event_commits_with_the_move(org_a, owner_client, crm, subscribed):
    """A refused move must leave no event behind: the outbox row lives in the same transaction."""
    deal = crm.make_deal(org_a)
    _clear_outboxes(org_a)

    resp = owner_client.post(
        f"/api/v1/deals/{deal.pk}/stage/",
        {"stage_id": str(uuid.uuid4()), "version": deal.version},
        format="json",
    )
    assert resp.status_code >= 400
    assert _events(org_a, deal.pk) == []


# --------------------------------------------------------------------------- lifecycle


def test_lifecycle_change_emits_an_update_event(org_a, owner_client, crm, subscribed):
    contact = crm.make_contact(org_a)
    _clear_outboxes(org_a)

    from apps.authz.actor import build_actor
    from apps.lifecycle import service as lifecycle

    with tenant_context(org_a.org.pk, user_id=org_a.owner.pk, membership_id=org_a.owner_membership.pk):
        actor = build_actor(org_a.owner_membership)
        record = type(contact).objects.get(pk=contact.pk)
        assert lifecycle.set_stage(actor, record, "customer") is True

    assert _events(org_a, contact.pk) == ["contact.updated"]
    with tenant_context(org_a.org.pk):
        assert LifecycleHistory.objects.filter(entity_id=contact.pk, to_stage="customer").exists()


# --------------------------------------------------------------------------- no double emission


def test_single_record_update_emits_exactly_one_event(org_a, owner_client, crm, subscribed):
    """The ORM signal and the domain event must not both fire for a write that went through save()."""
    contact = crm.make_contact(org_a)
    _clear_outboxes(org_a)

    resp = owner_client.patch(
        f"/api/v1/contacts/{contact.pk}/",
        {"first_name": "Renamed", "version": contact.version},
        format="json",
    )
    assert resp.status_code == 200, resp.content
    assert _events(org_a, contact.pk) == ["contact.updated"]


def test_events_are_not_emitted_for_organizations_without_subscriptions(org_a, owner_client, crm):
    """No webhook, no outbound policy: a bulk write still must not create outbox rows."""
    contacts = [crm.make_contact(org_a) for _ in range(2)]
    _clear_outboxes(org_a)

    owner_client.post(
        "/api/v1/contacts/bulk/",
        {"ids": [str(c.pk) for c in contacts], "action": "archive"},
        format="json",
    )
    for contact in contacts:
        assert _events(org_a, contact.pk) == []


def test_bulk_events_stay_inside_the_acting_tenant(org_a, org_b, owner_client, crm, subscribed):
    contact = crm.make_contact(org_a)
    _clear_outboxes(org_a)
    owner_client.post("/api/v1/contacts/bulk/", {"ids": [str(contact.pk)], "action": "archive"}, format="json")

    with tenant_context(org_b.org.pk):
        assert not IntegrationEvent.objects.filter(entity_id=contact.pk).exists()
    assert _events(org_a, contact.pk) == ["contact.updated"]
