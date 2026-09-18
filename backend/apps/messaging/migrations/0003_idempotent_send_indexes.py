"""The indexes behind the send state machine, built without locking the tables against writes.

Separate from ``0002`` because ``CREATE INDEX CONCURRENTLY`` cannot run inside a transaction, which
forces ``atomic = False`` on whatever migration contains it. Keeping that blast radius to index
creation alone is what makes the pair safely retryable:

- ``0002`` is atomic, so a failure there rolls back completely and can simply be re-run;
- this one is not, but every statement is ``IF NOT EXISTS``, so a re-run after a partial failure is a
  no-op for the indexes that already landed. A ``CONCURRENTLY`` build that is interrupted leaves an
  INVALID index behind; drop it and re-run (``DROP INDEX CONCURRENTLY IF EXISTS <name>``).

``SeparateDatabaseAndState`` lets Django keep the model state that the hand-written SQL produces.
"""

from __future__ import annotations

from django.db import migrations, models


class Migration(migrations.Migration):
    atomic = False

    dependencies = [
        ("messaging", "0002_idempotent_sends"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                # The reconciliation sweeper's read path: sends stuck mid-flight, oldest first.
                migrations.RunSQL(
                    "CREATE INDEX CONCURRENTLY IF NOT EXISTS email_status_claimed_idx "
                    "ON messaging_emailmessage (status, claimed_at);",
                    reverse_sql="DROP INDEX CONCURRENTLY IF EXISTS email_status_claimed_idx;",
                ),
                migrations.RunSQL(
                    "CREATE INDEX CONCURRENTLY IF NOT EXISTS wa_status_claimed_idx "
                    "ON messaging_whatsappmessage (status, claimed_at);",
                    reverse_sql="DROP INDEX CONCURRENTLY IF EXISTS wa_status_claimed_idx;",
                ),
                # The uniqueness that makes an idempotency key a key.
                migrations.RunSQL(
                    "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_email_idempotency_key "
                    "ON messaging_emailmessage (organization_id, idempotency_key);",
                    reverse_sql="DROP INDEX CONCURRENTLY IF EXISTS uniq_email_idempotency_key;",
                ),
                migrations.RunSQL(
                    "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uniq_whatsapp_idempotency_key "
                    "ON messaging_whatsappmessage (organization_id, idempotency_key);",
                    reverse_sql="DROP INDEX CONCURRENTLY IF EXISTS uniq_whatsapp_idempotency_key;",
                ),
            ],
            state_operations=[
                migrations.AddIndex(
                    model_name="emailmessage",
                    index=models.Index(fields=["status", "claimed_at"], name="email_status_claimed_idx"),
                ),
                migrations.AddIndex(
                    model_name="whatsappmessage",
                    index=models.Index(fields=["status", "claimed_at"], name="wa_status_claimed_idx"),
                ),
                migrations.AddConstraint(
                    model_name="emailmessage",
                    constraint=models.UniqueConstraint(
                        fields=("organization", "idempotency_key"), name="uniq_email_idempotency_key"
                    ),
                ),
                migrations.AddConstraint(
                    model_name="whatsappmessage",
                    constraint=models.UniqueConstraint(
                        fields=("organization", "idempotency_key"), name="uniq_whatsapp_idempotency_key"
                    ),
                ),
            ],
        ),
    ]
