from django.db import migrations

from apps.core.rls import enable_rls


class Migration(migrations.Migration):
    dependencies = [("automation", "0001_initial")]

    operations = [enable_rls("automation_automationrule"), enable_rls("automation_automationrun")]
