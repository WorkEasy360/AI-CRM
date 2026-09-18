"""Re-encrypt every stored provider secret with the current primary encryption key.

Key rotation (``MESSAGING_ENCRYPTION_KEYS``, see ``apps.core.crypto``):

    1. prepend a new key:   MESSAGING_ENCRYPTION_KEYS=<new>,<old>   and deploy (new writes use <new>)
    2. run this command:    python manage.py reencrypt_secrets        (old ciphertext is rewritten)
    3. drop the old key:    MESSAGING_ENCRYPTION_KEYS=<new>           and deploy

Covers mailbox and WhatsApp tokens, integration credentials and inbound/outbound webhook secrets.
Idempotent (values already under the primary key are left alone) and batched. Values that no configured
key can decrypt are counted and make the command fail, so step 3 is never taken while data would be lost.
Plaintext never leaves this process and is never printed.
"""

from __future__ import annotations

from django.apps import apps as django_apps
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.core import crypto
from apps.core.tenancy.context import system_context

ENCRYPTED_COLUMNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("messaging.EmailAccount", ("access_token_enc", "refresh_token_enc")),
    ("messaging.WhatsAppAccount", ("access_token_enc",)),
    ("integrations.IntegrationConnection", ("credentials_enc", "inbound_secret_enc", "inbound_previous_secret_enc")),
    ("integrations.WebhookSubscription", ("secret_enc", "previous_secret_enc")),
)
BATCH_SIZE = 500


class Command(BaseCommand):
    help = "Re-encrypt stored provider secrets with the primary key of MESSAGING_ENCRYPTION_KEYS."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true", help="Count what would change without writing.")

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        crypto.reset_key_cache()
        rewritten = unreadable = 0
        for label, columns in ENCRYPTED_COLUMNS:
            model = django_apps.get_model(label)
            last_pk = None
            while True:
                with system_context(f"reencrypt_secrets:{label}"), transaction.atomic():
                    qs = model.all_objects.order_by("pk").only("pk", *columns)
                    if last_pk is not None:
                        qs = qs.filter(pk__gt=last_pk)
                    rows = list(qs[:BATCH_SIZE])
                    for row in rows:
                        updates = {}
                        for column in columns:
                            value = getattr(row, column)
                            if not value:
                                continue
                            try:
                                rotated = crypto.rotate(value)
                            except crypto.DecryptionError:
                                unreadable += 1
                                self.stderr.write(f"unreadable: {label}.{column} id={row.pk}")
                                continue
                            if rotated != value:
                                updates[column] = rotated
                        if updates:
                            rewritten += len(updates)
                            if not dry_run:
                                model.all_objects.filter(pk=row.pk).update(**updates)
                if not rows:
                    break
                last_pk = rows[-1].pk
        verb = "would re-encrypt" if dry_run else "re-encrypted"
        self.stdout.write(f"{verb} {rewritten} value(s); {unreadable} unreadable")
        if unreadable:
            raise CommandError(
                f"{unreadable} value(s) cannot be decrypted with the configured keys. Keep the old key configured."
            )
