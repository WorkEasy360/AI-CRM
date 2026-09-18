"""Batch sync stays bounded: one task invocation never processes more than the configured batch."""

from __future__ import annotations

import httpx
import pytest

from apps.contacts.models import Contact
from apps.core.tenancy.context import tenant_context
from apps.integrations import sync
from apps.integrations.models import Direction, FieldMapping, SharingPolicy, SyncJob

pytestmark = pytest.mark.django_db


def test_sync_job_batches_are_bounded(org_a, crm, remote, settings):
    settings.INTEGRATIONS_SYNC_BATCH_SIZE = 10
    counter = iter(range(1000))
    remote.handle("POST", "/v1/contacts", lambda r: httpx.Response(201, json={"id": f"x{next(counter)}"}))
    conn = crm.make_integration_connection(org_a)
    with tenant_context(org_a.org.pk):
        SharingPolicy.objects.create(
            connection=conn, entity_type="contact", direction=Direction.OUTBOUND, external_resource="/contacts"
        )
        FieldMapping.objects.create(connection=conn, entity_type="contact", crm_field="email", external_field="email")
    for _ in range(25):
        crm.make_contact(org_a)
    with tenant_context(org_a.org.pk):
        Contact.objects.update(owner=org_a.owner_membership)
        job = SyncJob.objects.create(connection=conn)
        sync.run_job_batch(job)
        assert job.processed == 10 and len(remote.requests) == 10  # one batch never exceeds the batch size
        while sync.run_job_batch(job):
            pass
    assert job.processed == 25 and job.succeeded == 25
