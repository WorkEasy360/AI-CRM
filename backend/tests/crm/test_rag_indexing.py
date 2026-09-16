"""The knowledge index tracks the CRM: chunking, incremental updates, deletes, and no wasted embeddings."""

from __future__ import annotations

import uuid

import pytest
from django.test import override_settings

from apps.core.tenancy.context import tenant_context
from apps.rag import events, indexing, sources
from apps.rag.chunking import chunk_document, strip_email_noise
from apps.rag.models import IndexEvent, IndexStatus, KnowledgeChunk, SourceType

pytestmark = pytest.mark.django_db


def index_all(org):
    """Drain the outbox synchronously, the way the worker would."""
    with tenant_context(org.pk, reason="test.index_all"):
        rows = list(IndexEvent.objects.values_list("source_type", "source_id"))
        for source_type, source_id in rows:
            indexing.index_source(organization_id=org.pk, source_type=source_type, source_id=source_id)


def chunks_for(org, source_type, source_id):
    with tenant_context(org.pk, reason="test.chunks_for"):
        return list(KnowledgeChunk.objects.filter(source_type=source_type, source_id=source_id).order_by("chunk_index"))


# --------------------------------------------------------------------------- the pipeline


def test_a_note_becomes_a_chunk_through_the_outbox(org_a, crm):
    deal = crm.make_deal(org_a, name="Enterprise Expansion")
    note = crm.make_note(org_a, record=deal, body="Customer requested revised pricing before signing.")

    with tenant_context(org_a.org.pk, reason="test"):
        event = IndexEvent.objects.get(source_type=SourceType.NOTE, source_id=note.pk)
        assert event.status == IndexStatus.PENDING

    index_all(org_a.org)

    rows = chunks_for(org_a.org, SourceType.NOTE, note.pk)
    assert len(rows) == 1
    chunk = rows[0]
    assert "revised pricing" in chunk.content
    assert chunk.entity_type == "deal" and chunk.entity_id == deal.pk
    assert chunk.entity_owner_id == deal.owner_id
    assert chunk.embedding is not None and chunk.search_vector is not None
    with tenant_context(org_a.org.pk, reason="test"):
        assert IndexEvent.objects.get(pk=event.pk).status == IndexStatus.INDEXED


def test_editing_a_source_replaces_only_its_own_chunks(org_a, crm):
    deal = crm.make_deal(org_a)
    keep = crm.make_note(org_a, record=deal, body="Pricing was discussed at length during the meeting.")
    edit = crm.make_note(org_a, record=deal, body="Original body about implementation timelines.")
    index_all(org_a.org)
    keep_before = chunks_for(org_a.org, SourceType.NOTE, keep.pk)[0]

    with tenant_context(org_a.org.pk, reason="test"):
        edit.body = "Rewritten body: the customer now wants a phased rollout."
        edit.save(update_fields=["body", "updated_at"])
    index_all(org_a.org)

    edited = chunks_for(org_a.org, SourceType.NOTE, edit.pk)
    assert len(edited) == 1 and "phased rollout" in edited[0].content
    # The other note's chunk was neither touched nor removed: replacement is by exact source identity.
    keep_after = chunks_for(org_a.org, SourceType.NOTE, keep.pk)
    assert len(keep_after) == 1 and keep_after[0].pk == keep_before.pk


def test_unchanged_content_is_not_re_embedded(org_a, crm, monkeypatch):
    note = crm.make_note(org_a, body="Customer confirmed interest in the enterprise plan.")
    index_all(org_a.org)

    calls: list[int] = []
    real = indexing.get_embedder

    def counting():
        calls.append(1)
        return real()

    monkeypatch.setattr(indexing, "get_embedder", counting)

    # A save that does not change the text still enqueues, but must not cost an embedding call.
    with tenant_context(org_a.org.pk, reason="test"):
        note.pinned = True
        note.save(update_fields=["pinned", "updated_at"])
    index_all(org_a.org)
    assert calls == []

    with tenant_context(org_a.org.pk, reason="test"):
        note.body = "Customer confirmed interest and asked for a discount."
        note.save(update_fields=["body", "updated_at"])
    index_all(org_a.org)
    assert len(calls) == 1


def test_deleting_a_source_removes_exactly_its_chunks(org_a, crm):
    deal = crm.make_deal(org_a)
    doomed = crm.make_note(org_a, record=deal, body="Delete me: a note about pricing concerns.")
    survivor = crm.make_note(org_a, record=deal, body="Keep me: another note about pricing concerns.")
    index_all(org_a.org)
    assert chunks_for(org_a.org, SourceType.NOTE, doomed.pk)

    with tenant_context(org_a.org.pk, reason="test"):
        doomed_id = doomed.pk
        doomed.delete()
    index_all(org_a.org)

    assert chunks_for(org_a.org, SourceType.NOTE, doomed_id) == []
    # Same topic, same words, different record: untouched.
    assert len(chunks_for(org_a.org, SourceType.NOTE, survivor.pk)) == 1
    with tenant_context(org_a.org.pk, reason="test"):
        assert not IndexEvent.objects.filter(source_type=SourceType.NOTE, source_id=doomed_id).exists()


def test_emptying_a_note_drops_its_chunks(org_a, crm):
    note = crm.make_note(org_a, body="Something worth indexing about delivery timelines.")
    index_all(org_a.org)
    assert chunks_for(org_a.org, SourceType.NOTE, note.pk)

    with tenant_context(org_a.org.pk, reason="test"):
        note.body = "   "
        note.save(update_fields=["body", "updated_at"])
    index_all(org_a.org)
    assert chunks_for(org_a.org, SourceType.NOTE, note.pk) == []


def test_hard_deleting_a_record_purges_its_chunks(org_a, crm):
    """Retention and privacy erasure hard-delete records; their indexed text must go with them."""
    contact = crm.make_contact(org_a, first_name="Doomed")
    crm.make_note(org_a, record=contact, body="Notes that belong to a contact being erased.")
    index_all(org_a.org)
    with tenant_context(org_a.org.pk, reason="test"):
        assert KnowledgeChunk.objects.filter(entity_type="contact", entity_id=contact.pk).exists()
        contact_id = contact.pk
        contact.delete()
        assert not KnowledgeChunk.objects.filter(entity_type="contact", entity_id=contact_id).exists()


def test_a_write_during_indexing_is_not_lost(org_a, crm):
    """The worker must not mark a row indexed if the source changed while it was working."""
    note = crm.make_note(org_a, body="First version of the note.")
    with tenant_context(org_a.org.pk, reason="test"):
        event = IndexEvent.objects.get(source_id=note.pk)
        # Simulate a concurrent write landing after the worker captured the revision.
        stale_revision = event.revision
        IndexEvent.objects.filter(pk=event.pk).update(revision=stale_revision + 1)
        indexing._settle(event, revision=stale_revision, result=indexing.IndexResult(status="indexed", chunks=1))
        assert IndexEvent.objects.get(pk=event.pk).status == IndexStatus.PENDING


def test_email_and_whatsapp_and_activity_are_indexed(org_a, crm):
    contact = crm.make_contact(org_a, first_name="Grace")
    deal = crm.make_deal(org_a, contact=contact)
    email = crm.make_email_message(
        org_a, contact=contact, deal=deal, subject="Proposal", body_text="Attached is the revised proposal."
    )
    whatsapp = crm.make_whatsapp_message(org_a, contact=contact, body="Can you confirm the implementation timeline?")
    meeting = crm.make_activity(
        org_a, kind="meeting", deal=deal, title="Pricing review", description="Customer pushed back on price."
    )
    index_all(org_a.org)

    assert chunks_for(org_a.org, SourceType.EMAIL, email.pk)
    assert chunks_for(org_a.org, SourceType.WHATSAPP, whatsapp.pk)
    activity_chunks = chunks_for(org_a.org, SourceType.ACTIVITY, meeting.pk)
    assert activity_chunks and "pushed back on price" in activity_chunks[0].content


def test_a_task_without_a_description_is_not_indexed(org_a, crm):
    task = crm.make_activity(org_a, kind="task", title="Call them back")
    index_all(org_a.org)
    assert chunks_for(org_a.org, SourceType.ACTIVITY, task.pk) == []


def test_reassigning_a_record_updates_the_chunk_owner(org_a, crm, make_member):
    deal = crm.make_deal(org_a)
    crm.make_note(org_a, record=deal, body="A note that must follow the deal's owner.")
    index_all(org_a.org)
    new_owner = make_member(org_a, "sales_rep")

    with tenant_context(org_a.org.pk, reason="test"):
        from apps.deals.models import Deal

        reloaded = Deal.objects.get(pk=deal.pk)
        reloaded.owner = new_owner
        reloaded.save(update_fields=["owner", "updated_at"])
        assert (
            KnowledgeChunk.objects.filter(entity_type="deal", entity_id=deal.pk)
            .exclude(entity_owner_id=new_owner.pk)
            .count()
            == 0
        )


# --------------------------------------------------------------------------- chunking


def test_quoted_reply_chains_are_stripped():
    body = "Thanks, that works for me.\n\nOn Tue, Alice wrote:\n> the original proposal\n> second line"
    assert "original proposal" not in strip_email_noise(body)
    assert "works for me" in strip_email_noise(body)


def test_a_whatsapp_message_is_one_chunk_with_a_dated_header(org_a, crm):
    message = crm.make_whatsapp_message(org_a, body="ok")
    with tenant_context(org_a.org.pk, reason="test"):
        document = sources.document_for(SourceType.WHATSAPP, message)
    produced = chunk_document(document)
    assert len(produced) == 1
    assert produced[0].content.startswith("[WhatsApp")


def test_a_long_note_is_split_but_bounded(org_a, crm):
    paragraphs = "\n\n".join(f"Paragraph {i} about the customer's procurement process." * 12 for i in range(12))
    note = crm.make_note(org_a, body=paragraphs)
    with tenant_context(org_a.org.pk, reason="test"):
        document = sources.document_for(SourceType.NOTE, note)
    produced = chunk_document(document)
    assert 1 < len(produced) <= 3
    assert all(len(c.content) < 2000 for c in produced)


# --------------------------------------------------------------------------- failure handling


def test_an_embedding_failure_leaves_the_source_pending_and_the_crm_intact(org_a, crm, monkeypatch):
    from apps.rag.embeddings import EmbeddingError

    note = crm.make_note(org_a, body="A note the embedding provider will refuse to embed.")

    class Broken:
        def embed(self, texts):
            raise EmbeddingError("provider down", retryable=True, status=503)

    monkeypatch.setattr(indexing, "get_embedder", lambda: Broken())
    with tenant_context(org_a.org.pk, reason="test"):
        result = indexing.index_source(organization_id=org_a.org.pk, source_type=SourceType.NOTE, source_id=note.pk)
        assert result.status == IndexStatus.FAILED
        event = IndexEvent.objects.get(source_id=note.pk)
        assert event.status == IndexStatus.PENDING and event.attempts == 1 and event.available_at is not None
        # The CRM row is untouched.
        note.refresh_from_db()
        assert note.body.startswith("A note the embedding provider")


def test_a_missing_source_row_drops_its_chunks(org_a, crm):
    with tenant_context(org_a.org.pk, reason="test"):
        result = indexing.index_source(
            organization_id=org_a.org.pk, source_type=SourceType.NOTE, source_id=uuid.uuid4()
        )
        assert result.status == "deleted"


@override_settings(RAG_EMBEDDING_BACKEND="local")
def test_rebuild_is_idempotent_and_resume_safe(org_a, crm):
    crm.make_note(org_a, body="Indexed once, queued twice, embedded once.")
    index_all(org_a.org)
    with tenant_context(org_a.org.pk, reason="test"):
        before = list(KnowledgeChunk.objects.values_list("pk", flat=True))
        from apps.rag import tasks

        tasks.rebuild_organization(organization_id=org_a.org.pk)
    index_all(org_a.org)
    with tenant_context(org_a.org.pk, reason="test"):
        assert sorted(KnowledgeChunk.objects.values_list("pk", flat=True)) == sorted(before)


def test_enqueue_is_idempotent_per_source(org_a, crm):
    note = crm.make_note(org_a, body="One outbox row per source, however many writes.")
    with tenant_context(org_a.org.pk, reason="test"):
        for _ in range(3):
            events.enqueue(organization_id=org_a.org.pk, source_type=SourceType.NOTE, source_id=note.pk)
        assert IndexEvent.objects.filter(source_type=SourceType.NOTE, source_id=note.pk).count() == 1
