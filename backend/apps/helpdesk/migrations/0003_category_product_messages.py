import uuid

import django.db.models.deletion
from django.db import migrations, models

from apps.core.rls import enable_rls


class Migration(migrations.Migration):
    """Additive: ticket category and product, and the ticket thread (replies, customer messages, notes)."""

    dependencies = [
        ("accounts", "0006_membership_hierarchy_role"),
        ("products", "0004_pricebook_rls"),
        ("helpdesk", "0002_rls"),
    ]

    operations = [
        migrations.AddField(
            model_name="ticket",
            name="category",
            field=models.CharField(
                choices=[
                    ("technical", "Technical"),
                    ("billing", "Billing"),
                    ("account", "Account"),
                    ("support", "Support"),
                    ("sales", "Sales"),
                    ("other", "Other"),
                ],
                default="support",
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name="ticket",
            name="product",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="+",
                to="products.product",
            ),
        ),
        migrations.CreateModel(
            name="TicketMessage",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "kind",
                    models.CharField(
                        choices=[("reply", "Reply"), ("customer", "Customer message"), ("note", "Internal note")],
                        max_length=16,
                    ),
                ),
                (
                    "channel",
                    models.CharField(
                        blank=True,
                        choices=[("", "Not sent"), ("email", "Email"), ("whatsapp", "WhatsApp")],
                        default="",
                        max_length=16,
                    ),
                ),
                ("author_name", models.CharField(blank=True, max_length=160)),
                ("body", models.TextField()),
                (
                    "author",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="accounts.membership",
                    ),
                ),
                (
                    "organization",
                    models.ForeignKey(
                        editable=False,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="+",
                        to="accounts.organization",
                    ),
                ),
                (
                    "ticket",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, related_name="messages", to="helpdesk.ticket"
                    ),
                ),
            ],
            options={
                "ordering": ["created_at", "id"],
                "indexes": [
                    models.Index(fields=["organization", "ticket", "created_at"], name="ticketmsg_org_ticket_idx")
                ],
            },
        ),
        enable_rls("helpdesk_ticketmessage"),
    ]
