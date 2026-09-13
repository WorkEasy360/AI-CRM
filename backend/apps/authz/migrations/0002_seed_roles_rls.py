from django.db import migrations

from apps.core.rls import ORG_SETTING, enable_rls


class Migration(migrations.Migration):
    dependencies = [("authz", "0001_initial")]

    operations = [
        # System roles (organization NULL) are visible to every tenant; custom roles only to their own.
        enable_rls("authz_role", extra="organization_id IS NULL"),
        enable_rls(
            "authz_rolepermission",
            condition=f"role_id IN (SELECT id FROM authz_role WHERE organization_id = {ORG_SETTING})",
        ),
    ]
