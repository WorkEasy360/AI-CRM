from django.db import migrations

from apps.core.rls import enable_rls


class Migration(migrations.Migration):
    dependencies = [("helpdesk", "0001_initial")]

    operations = [enable_rls("helpdesk_ticket")]
