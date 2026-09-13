import uuid

import django.db.models.deletion
from django.db import migrations, models

from apps.core.rls import enable_rls


class Migration(migrations.Migration):
    initial = True

    dependencies = [("accounts", "0003_rls")]

    operations = [
        migrations.CreateModel(
            name="AIUsage",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("day", models.DateField()),
                ("feature", models.CharField(max_length=32)),
                ("model", models.CharField(max_length=64)),
                ("requests", models.PositiveIntegerField(default=0)),
                ("input_tokens", models.PositiveBigIntegerField(default=0)),
                ("output_tokens", models.PositiveBigIntegerField(default=0)),
                ("cache_read_tokens", models.PositiveBigIntegerField(default=0)),
                ("estimated_cost_usd", models.DecimalField(decimal_places=6, default=0, max_digits=12)),
                ("flagged_inputs", models.PositiveIntegerField(default=0)),
                (
                    "membership",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE, related_name="ai_usage", to="accounts.membership"
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
        migrations.AddConstraint(
            model_name="aiusage",
            constraint=models.UniqueConstraint(
                fields=("organization", "membership", "day", "feature", "model"), name="uniq_ai_usage_bucket"
            ),
        ),
        migrations.AddIndex(
            model_name="aiusage", index=models.Index(fields=["organization", "day"], name="aiusage_org_day_idx")
        ),
        enable_rls("ai_aiusage"),
    ]
