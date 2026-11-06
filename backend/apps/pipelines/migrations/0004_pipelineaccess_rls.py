from django.db import migrations

from apps.core.rls import enable_rls


class Migration(migrations.Migration):
    dependencies = [("pipelines", "0003_pipelineaccess_pipeline_layout_pipeline_parent_and_more")]

    operations = [enable_rls("pipelines_pipelineaccess")]
