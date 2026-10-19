from django.db import migrations

from apps.core.rls import enable_rls


class Migration(migrations.Migration):
    dependencies = [("importexport", "0004_rollback_preview_xlsx")]

    operations = [enable_rls("importexport_importrow")]
