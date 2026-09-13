import uuid

import django.db.models.deletion
from django.db import migrations, models

from apps.core.rls import append_only_trigger, enable_rls

STAGES = [
    ("lead", "Lead"),
    ("prospect", "Prospect"),
    ("qualified", "Qualified"),
    ("customer", "Customer"),
    ("inactive", "Inactive"),
]


class Migration(migrations.Migration):
    initial = True

    dependencies = [("accounts", "0003_rls")]

    operations = [
        migrations.CreateModel(
            name="LifecycleHistory",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("entity_type", models.CharField(max_length=16)),
                ("entity_id", models.UUIDField()),
                ("from_stage", models.CharField(blank=True, choices=STAGES, max_length=16)),
                ("to_stage", models.CharField(choices=STAGES, max_length=16)),
                ("changed_at", models.DateTimeField()),
                (
                    "source",
                    models.CharField(
                        choices=[("user", "User"), ("automation", "Automation"), ("import", "Import")],
                        default="user",
                        max_length=16,
                    ),
                ),
                ("reason", models.CharField(blank=True, max_length=255)),
                (
                    "changed_by",
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
            ],
            options={"ordering": ["-changed_at"]},
        ),
        migrations.AddIndex(
            model_name="lifecyclehistory",
            index=models.Index(
                fields=["organization", "entity_type", "entity_id", "-changed_at"], name="lifecycle_entity_idx"
            ),
        ),
        migrations.AddIndex(
            model_name="lifecyclehistory",
            index=models.Index(fields=["organization", "to_stage", "-changed_at"], name="lifecycle_org_stage_idx"),
        ),
        enable_rls("lifecycle_lifecyclehistory"),
        append_only_trigger("lifecycle_lifecyclehistory"),
    ]
