from django.db import migrations

from apps.core.rls import enable_rls


class Migration(migrations.Migration):
    dependencies = [("notes", "0001_initial")]

    operations = [enable_rls("notes_note")]
