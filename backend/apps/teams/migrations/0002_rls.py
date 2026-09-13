from django.db import migrations

from apps.core.rls import enable_rls


class Migration(migrations.Migration):
    dependencies = [("teams", "0001_initial")]

    operations = [
        enable_rls("teams_team"),
        enable_rls("teams_teammembership"),
    ]
