import uuid

import django.db.models.deletion
from django.db import migrations, models

from apps.core.rls import enable_rls

STATUS = [("connected", "Connected"), ("error", "Needs attention"), ("disconnected", "Disconnected")]
DIRECTION = [("outbound", "Outbound"), ("inbound", "Inbound")]


def org_fk():
    return models.ForeignKey(
        editable=False, on_delete=django.db.models.deletion.CASCADE, related_name="+", to="accounts.organization"
    )


def member_fk(related="+"):
    return models.ForeignKey(
        blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name=related, to="accounts.membership"
    )


def base_fields():
    return [
        ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
        ("created_at", models.DateTimeField(auto_now_add=True)),
        ("updated_at", models.DateTimeField(auto_now=True)),
    ]


class Migration(migrations.Migration):
    initial = True

    dependencies = [
        ("accounts", "0003_rls"),
        ("contacts", "0003_lifecycle_activity"),
        ("companies", "0003_lifecycle_activity"),
        ("deals", "0006_probability_overridden"),
    ]

    operations = [
        migrations.CreateModel(
            name="EmailAccount",
            fields=[
                *base_fields(),
                ("provider", models.CharField(choices=[("gmail", "Gmail"), ("microsoft", "Microsoft 365")], max_length=16)),
                ("email_address", models.EmailField(max_length=254)),
                ("display_name", models.CharField(blank=True, max_length=120)),
                ("status", models.CharField(choices=STATUS, default="connected", max_length=16)),
                ("access_token_enc", models.TextField(blank=True)),
                ("refresh_token_enc", models.TextField(blank=True)),
                ("token_expires_at", models.DateTimeField(blank=True, null=True)),
                ("scopes", models.JSONField(blank=True, default=list)),
                ("last_sync_at", models.DateTimeField(blank=True, null=True)),
                ("sync_cursor", models.CharField(blank=True, max_length=512)),
                ("error_message", models.CharField(blank=True, max_length=255)),
                ("connected_at", models.DateTimeField(blank=True, null=True)),
                ("disconnected_at", models.DateTimeField(blank=True, null=True)),
                (
                    "membership",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, related_name="email_accounts", to="accounts.membership"
                    ),
                ),
                ("organization", org_fk()),
            ],
        ),
        migrations.CreateModel(
            name="EmailTemplate",
            fields=[
                *base_fields(),
                ("name", models.CharField(max_length=80)),
                ("subject", models.CharField(blank=True, max_length=255)),
                ("body", models.TextField()),
                ("is_shared", models.BooleanField(default=True)),
                ("created_by", member_fk()),
                ("organization", org_fk()),
            ],
            options={"ordering": ["name"]},
        ),
        migrations.CreateModel(
            name="EmailMessage",
            fields=[
                *base_fields(),
                ("direction", models.CharField(choices=DIRECTION, max_length=8)),
                (
                    "status",
                    models.CharField(
                        choices=[("queued", "Queued"), ("sent", "Sent"), ("failed", "Failed"), ("received", "Received")],
                        default="queued",
                        max_length=8,
                    ),
                ),
                ("from_address", models.CharField(blank=True, max_length=254)),
                ("to_addresses", models.JSONField(blank=True, default=list)),
                ("cc_addresses", models.JSONField(blank=True, default=list)),
                ("bcc_addresses", models.JSONField(blank=True, default=list)),
                ("subject", models.CharField(blank=True, max_length=255)),
                ("body_text", models.TextField(blank=True)),
                ("snippet", models.CharField(blank=True, max_length=300)),
                ("provider_message_id", models.CharField(blank=True, max_length=255)),
                ("provider_thread_id", models.CharField(blank=True, max_length=255)),
                ("in_reply_to", models.CharField(blank=True, max_length=255)),
                ("sent_at", models.DateTimeField(blank=True, null=True)),
                ("received_at", models.DateTimeField(blank=True, null=True)),
                ("error_message", models.CharField(blank=True, max_length=255)),
                ("ai_assisted", models.BooleanField(default=False)),
                (
                    "account",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="messages",
                        to="messaging.emailaccount",
                    ),
                ),
                (
                    "company",
                    models.ForeignKey(
                        blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="emails", to="companies.company"
                    ),
                ),
                (
                    "contact",
                    models.ForeignKey(
                        blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="emails", to="contacts.contact"
                    ),
                ),
                (
                    "deal",
                    models.ForeignKey(
                        blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="emails", to="deals.deal"
                    ),
                ),
                ("organization", org_fk()),
                ("sent_by", member_fk()),
                (
                    "template",
                    models.ForeignKey(
                        blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="+", to="messaging.emailtemplate"
                    ),
                ),
            ],
            options={"ordering": ["-created_at"]},
        ),
        migrations.CreateModel(
            name="EmailAttachment",
            fields=[
                *base_fields(),
                ("filename", models.CharField(max_length=255)),
                ("content_type", models.CharField(max_length=120)),
                ("size_bytes", models.PositiveIntegerField()),
                ("storage_key", models.CharField(max_length=512)),
                (
                    "message",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, related_name="attachments", to="messaging.emailmessage"
                    ),
                ),
                ("organization", org_fk()),
            ],
        ),
        migrations.CreateModel(
            name="WhatsAppAccount",
            fields=[
                *base_fields(),
                ("phone_number_id", models.CharField(max_length=64)),
                ("business_account_id", models.CharField(blank=True, max_length=64)),
                ("display_phone", models.CharField(blank=True, max_length=32)),
                ("display_name", models.CharField(blank=True, max_length=120)),
                ("access_token_enc", models.TextField(blank=True)),
                ("status", models.CharField(choices=STATUS, default="connected", max_length=16)),
                ("error_message", models.CharField(blank=True, max_length=255)),
                ("connected_at", models.DateTimeField(blank=True, null=True)),
                ("connected_by", member_fk()),
                ("organization", org_fk()),
            ],
        ),
        migrations.CreateModel(
            name="WhatsAppTemplate",
            fields=[
                *base_fields(),
                ("name", models.CharField(max_length=120)),
                ("language", models.CharField(default="en", max_length=16)),
                ("category", models.CharField(blank=True, max_length=32)),
                ("body", models.TextField(blank=True)),
                ("parameter_count", models.PositiveSmallIntegerField(default=0)),
                ("status", models.CharField(default="approved", max_length=16)),
                ("organization", org_fk()),
            ],
            options={"ordering": ["name"]},
        ),
        migrations.CreateModel(
            name="WhatsAppMessage",
            fields=[
                *base_fields(),
                ("direction", models.CharField(choices=DIRECTION, max_length=8)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("queued", "Queued"),
                            ("sent", "Sent"),
                            ("delivered", "Delivered"),
                            ("read", "Read"),
                            ("failed", "Failed"),
                            ("received", "Received"),
                        ],
                        default="queued",
                        max_length=10,
                    ),
                ),
                ("wa_id", models.CharField(max_length=32)),
                ("message_type", models.CharField(choices=[("text", "Text"), ("template", "Template")], default="text", max_length=10)),
                ("body", models.TextField(blank=True)),
                ("template_params", models.JSONField(blank=True, default=list)),
                ("provider_message_id", models.CharField(blank=True, max_length=255)),
                ("sent_at", models.DateTimeField(blank=True, null=True)),
                ("received_at", models.DateTimeField(blank=True, null=True)),
                ("error_message", models.CharField(blank=True, max_length=255)),
                ("ai_assisted", models.BooleanField(default=False)),
                (
                    "account",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="messages",
                        to="messaging.whatsappaccount",
                    ),
                ),
                (
                    "company",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="whatsapp_messages",
                        to="companies.company",
                    ),
                ),
                (
                    "contact",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="whatsapp_messages",
                        to="contacts.contact",
                    ),
                ),
                (
                    "deal",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="whatsapp_messages",
                        to="deals.deal",
                    ),
                ),
                ("organization", org_fk()),
                ("sent_by", member_fk()),
                (
                    "template",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="+",
                        to="messaging.whatsapptemplate",
                    ),
                ),
            ],
            options={"ordering": ["-created_at"]},
        ),
        # constraints / indexes
        migrations.AddConstraint(
            model_name="emailaccount",
            constraint=models.UniqueConstraint(
                condition=models.Q(("status__in", ["connected", "error"])),
                fields=("organization", "membership"),
                name="uniq_active_email_account_per_member",
            ),
        ),
        migrations.AddIndex(
            model_name="emailaccount",
            index=models.Index(fields=["organization", "status"], name="emailaccount_org_status_idx"),
        ),
        migrations.AddConstraint(
            model_name="emailtemplate",
            constraint=models.UniqueConstraint(fields=("organization", "name"), name="uniq_email_template_name"),
        ),
        migrations.AddIndex(
            model_name="emailmessage",
            index=models.Index(fields=["organization", "contact", "-created_at"], name="email_org_contact_idx"),
        ),
        migrations.AddIndex(
            model_name="emailmessage",
            index=models.Index(fields=["organization", "deal", "-created_at"], name="email_org_deal_idx"),
        ),
        migrations.AddIndex(
            model_name="emailmessage",
            index=models.Index(fields=["organization", "company", "-created_at"], name="email_org_company_idx"),
        ),
        migrations.AddIndex(
            model_name="emailmessage",
            index=models.Index(fields=["organization", "sent_by", "-created_at"], name="email_org_sender_idx"),
        ),
        migrations.AddIndex(
            model_name="emailmessage",
            index=models.Index(fields=["organization", "provider_thread_id"], name="email_org_thread_idx"),
        ),
        migrations.AddConstraint(
            model_name="emailmessage",
            constraint=models.UniqueConstraint(
                condition=models.Q(("provider_message_id", ""), _negated=True),
                fields=("organization", "account", "provider_message_id"),
                name="uniq_email_provider_message",
            ),
        ),
        migrations.AddConstraint(
            model_name="whatsappaccount",
            constraint=models.UniqueConstraint(fields=("organization",), name="uniq_whatsapp_account_per_org"),
        ),
        migrations.AddIndex(
            model_name="whatsappaccount", index=models.Index(fields=["phone_number_id"], name="wa_phone_number_idx")
        ),
        migrations.AddConstraint(
            model_name="whatsapptemplate",
            constraint=models.UniqueConstraint(fields=("organization", "name", "language"), name="uniq_whatsapp_template"),
        ),
        migrations.AddIndex(
            model_name="whatsappmessage",
            index=models.Index(fields=["organization", "wa_id", "-created_at"], name="wa_org_waid_idx"),
        ),
        migrations.AddIndex(
            model_name="whatsappmessage",
            index=models.Index(fields=["organization", "contact", "-created_at"], name="wa_org_contact_idx"),
        ),
        migrations.AddIndex(
            model_name="whatsappmessage",
            index=models.Index(fields=["organization", "deal", "-created_at"], name="wa_org_deal_idx"),
        ),
        migrations.AddConstraint(
            model_name="whatsappmessage",
            constraint=models.UniqueConstraint(
                condition=models.Q(("provider_message_id", ""), _negated=True),
                fields=("organization", "provider_message_id"),
                name="uniq_whatsapp_provider_message",
            ),
        ),
        enable_rls("messaging_emailaccount"),
        enable_rls("messaging_emailtemplate"),
        enable_rls("messaging_emailmessage"),
        enable_rls("messaging_emailattachment"),
        enable_rls("messaging_whatsappaccount"),
        enable_rls("messaging_whatsapptemplate"),
        enable_rls("messaging_whatsappmessage"),
    ]
