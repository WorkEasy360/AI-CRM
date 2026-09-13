import uuid

import django.db.models.deletion
from django.db import migrations, models

from apps.core.rls import enable_rls

KINDS = [
    ("task_due", "Task due"),
    ("meeting_soon", "Meeting approaching"),
    ("call_soon", "Call scheduled"),
    ("deal_assigned", "Deal assigned to you"),
    ("deal_inactive", "Deal inactivity warning"),
    ("customer_replied", "Customer replied"),
    ("ai_high_risk", "Deal at high risk"),
]


class Migration(migrations.Migration):
    initial = True

    dependencies = [("accounts", "0003_rls")]

    operations = [
        migrations.CreateModel(
            name="Notification",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("kind", models.CharField(choices=KINDS, max_length=32)),
                ("title", models.CharField(max_length=200)),
                ("body", models.CharField(blank=True, max_length=500)),
                ("entity_type", models.CharField(blank=True, max_length=16)),
                ("entity_id", models.UUIDField(blank=True, null=True)),
                ("read_at", models.DateTimeField(blank=True, null=True)),
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
                    "recipient",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="notifications",
                        to="accounts.membership",
                    ),
                ),
            ],
            options={"ordering": ["-created_at"]},
        ),
        migrations.CreateModel(
            name="NotificationPreference",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("in_app", models.JSONField(blank=True, default=dict)),
                ("email", models.JSONField(blank=True, default=dict)),
                ("deal_inactive_days", models.PositiveSmallIntegerField(default=14)),
                (
                    "membership",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="notification_preference",
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
            ],
        ),
        migrations.AddIndex(
            model_name="notification",
            index=models.Index(fields=["organization", "recipient", "read_at", "-created_at"], name="notif_recipient_idx"),
        ),
        migrations.AddIndex(
            model_name="notification",
            index=models.Index(fields=["organization", "recipient", "kind", "entity_id"], name="notif_dedupe_idx"),
        ),
        enable_rls("notifications_notification"),
        enable_rls("notifications_notificationpreference"),
    ]
