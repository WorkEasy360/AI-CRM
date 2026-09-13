from django.db import migrations

from apps.core.rls import append_only_trigger, enable_rls


class Migration(migrations.Migration):
    dependencies = [("audit", "0001_initial")]

    operations = [
        enable_rls("audit_auditevent"),
        append_only_trigger("audit_auditevent"),
    ]
