import uuid

import django.db.models.deletion
from django.db import migrations, models

from apps.core.rls import enable_rls


class Migration(migrations.Migration):
    initial = True
    dependencies = [("accounts", "0003_rls")]

    operations = [
        migrations.CreateModel(
            name="Widget",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("name", models.CharField(max_length=80)),
                (
                    "organization",
                    models.ForeignKey(
                        editable=False, on_delete=django.db.models.deletion.CASCADE, related_name="+",
                        to="accounts.organization",
                    ),
                ),
                (
                    "owner",
                    models.ForeignKey(
                        blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="+",
                        to="accounts.membership",
                    ),
                ),
            ],
        ),
        enable_rls("testapp_widget"),
    ]
