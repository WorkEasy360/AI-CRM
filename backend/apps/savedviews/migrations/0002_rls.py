from django.db import migrations

from apps.core.rls import enable_rls


class Migration(migrations.Migration):
    dependencies = [("savedviews", "0001_initial")]

    operations = [enable_rls("savedviews_savedview"), enable_rls("savedviews_savedviewdefault")]
