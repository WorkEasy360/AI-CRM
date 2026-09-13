from django.db import migrations

from apps.core.rls import enable_rls


class Migration(migrations.Migration):
    dependencies = [("pipelines", "0001_initial")]

    operations = [enable_rls("pipelines_pipeline"), enable_rls("pipelines_pipelinestage")]
