from django.db import migrations

from apps.core.rls import enable_rls


class Migration(migrations.Migration):
    dependencies = [("tagging", "0001_initial")]

    operations = [enable_rls("tagging_tag"), enable_rls("tagging_taggeditem")]
