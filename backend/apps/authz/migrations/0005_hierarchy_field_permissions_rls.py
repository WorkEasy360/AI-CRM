from django.db import migrations

from apps.core.rls import enable_rls


class Migration(migrations.Migration):
    dependencies = [("authz", "0004_hierarchy_field_permissions")]

    operations = [
        enable_rls("authz_hierarchyrole"),
        enable_rls("authz_fieldpermission"),
    ]
