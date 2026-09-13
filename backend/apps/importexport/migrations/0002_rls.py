from django.db import migrations

from apps.core.rls import enable_rls


class Migration(migrations.Migration):
    dependencies = [("importexport", "0001_initial")]

    operations = [enable_rls("importexport_importjob"), enable_rls("importexport_exportjob")]
