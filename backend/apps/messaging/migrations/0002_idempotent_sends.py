"""Idempotent outbound sends: a per-message key, the SENDING/UNCONFIRMED states and attempt bookkeeping.

Written in the expand -> backfill -> constrain shape documented in
``docs/operations/migrations.md``, because the obvious version of it is wrong twice over:

1. Django evaluates a callable column default **once**, so a plain ``AddField(default=uuid.uuid4)``
   would stamp every existing row with the *same* key and the unique index would then refuse to build.
2. These tables have ``FORCE ROW LEVEL SECURITY``, and a migration runs with no organization bound.
   An ORM backfill therefore matches **zero rows** -- silently, because RLS hides them rather than
   raising -- while the subsequent ``SET NOT NULL`` scan is DDL, sees every row, finds the nulls the
   backfill did not fill, and fails. So the backfill sets the transaction-local system flag first,
   exactly as ``accounts/0004`` does.

This migration is atomic: expand, backfill and constrain either all land or none do, so a failure is
cleanly retryable. The indexes that must be built ``CONCURRENTLY`` (which PostgreSQL refuses inside a
transaction) live in ``0003_idempotent_send_indexes`` on their own.
"""

from __future__ import annotations

import uuid

from django.db import migrations, models

BACKFILL_BATCH = 5000


def _backfill(apps, schema_editor, model_name: str) -> None:
    """Give each existing row its own key, in bounded batches.

    ``set_config('app.system', 'on', true)`` is transaction-local and is what makes the rows visible
    at all; without it every statement below is a no-op against an RLS-protected table.
    """
    model = apps.get_model("messaging", model_name)
    schema_editor.execute("SELECT set_config('app.system', 'on', true)")
    while True:
        ids = list(model.objects.filter(idempotency_key__isnull=True).values_list("pk", flat=True)[:BACKFILL_BATCH])
        if not ids:
            return
        for pk in ids:
            model.objects.filter(pk=pk).update(idempotency_key=uuid.uuid4())


def backfill_email(apps, schema_editor):
    _backfill(apps, schema_editor, "EmailMessage")


def backfill_whatsapp(apps, schema_editor):
    _backfill(apps, schema_editor, "WhatsAppMessage")


def noop(apps, schema_editor):
    """Reverse of the backfill: the columns are dropped by the reversed AddField anyway."""


class Migration(migrations.Migration):
    dependencies = [
        ("accounts", "0004_invitation_details_member_status"),
        ("companies", "0003_lifecycle_activity"),
        ("contacts", "0003_lifecycle_activity"),
        ("deals", "0006_probability_overridden"),
        ("messaging", "0001_initial"),
    ]

    operations = [
        # ---------------------------------------------------------------- 1. expand
        migrations.AddField(
            model_name="emailmessage",
            name="idempotency_key",
            field=models.UUIDField(editable=False, null=True),
        ),
        migrations.AddField(
            model_name="whatsappmessage",
            name="idempotency_key",
            field=models.UUIDField(editable=False, null=True),
        ),
        migrations.AddField(
            model_name="emailmessage", name="claimed_at", field=models.DateTimeField(blank=True, null=True)
        ),
        migrations.AddField(
            model_name="emailmessage", name="provider_attempted_at", field=models.DateTimeField(blank=True, null=True)
        ),
        migrations.AddField(
            model_name="emailmessage", name="send_attempts", field=models.PositiveSmallIntegerField(default=0)
        ),
        migrations.AddField(
            model_name="whatsappmessage", name="claimed_at", field=models.DateTimeField(blank=True, null=True)
        ),
        migrations.AddField(
            model_name="whatsappmessage",
            name="provider_attempted_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="whatsappmessage", name="send_attempts", field=models.PositiveSmallIntegerField(default=0)
        ),
        # ---------------------------------------------------------------- 2. backfill
        migrations.RunPython(backfill_email, noop),
        migrations.RunPython(backfill_whatsapp, noop),
        # ---------------------------------------------------------------- 3. constrain
        migrations.AlterField(
            model_name="emailmessage",
            name="idempotency_key",
            field=models.UUIDField(default=uuid.uuid4, editable=False),
        ),
        migrations.AlterField(
            model_name="whatsappmessage",
            name="idempotency_key",
            field=models.UUIDField(default=uuid.uuid4, editable=False),
        ),
        migrations.AlterField(
            model_name="emailmessage",
            name="status",
            field=models.CharField(
                choices=[
                    ("queued", "Queued"),
                    ("sending", "Sending"),
                    ("sent", "Sent"),
                    ("failed", "Failed"),
                    ("unconfirmed", "Delivery unconfirmed"),
                    ("received", "Received"),
                ],
                default="queued",
                max_length=12,
            ),
        ),
        migrations.AlterField(
            model_name="whatsappmessage",
            name="status",
            field=models.CharField(
                choices=[
                    ("queued", "Queued"),
                    ("sending", "Sending"),
                    ("sent", "Sent"),
                    ("delivered", "Delivered"),
                    ("read", "Read"),
                    ("failed", "Failed"),
                    ("unconfirmed", "Delivery unconfirmed"),
                    ("received", "Received"),
                ],
                default="queued",
                max_length=12,
            ),
        ),
    ]
