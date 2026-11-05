import uuid

import django.db.models.deletion
from django.db import migrations, models

from apps.core.rls import enable_rls


class Migration(migrations.Migration):
    """Additive: per-member favourite records, row-level secured like every tenant table."""

    dependencies = [
        ("accounts", "0006_membership_hierarchy_role"),
        ("tagging", "0002_rls"),
    ]

    operations = [
        migrations.CreateModel(
            name="Favorite",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("entity_type", models.CharField(max_length=16)),
                ("entity_id", models.UUIDField()),
                (
                    "membership",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, related_name="+", to="accounts.membership"
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
            options={
                "indexes": [
                    models.Index(fields=["organization", "membership", "entity_type"], name="favorite_org_member_idx")
                ],
                "constraints": [
                    models.UniqueConstraint(fields=("membership", "entity_type", "entity_id"), name="uniq_favorite")
                ],
            },
        ),
        enable_rls("tagging_favorite"),
    ]
