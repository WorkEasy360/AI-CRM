from django.db import migrations

from apps.core.rls import enable_rls


class Migration(migrations.Migration):
    dependencies = [("files", "0001_initial")]

    operations = [enable_rls("files_fileattachment")]
