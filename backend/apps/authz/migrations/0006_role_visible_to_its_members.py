"""A custom role is also readable by the people who hold it, from any context.

Session bootstrap and the organization switcher list a user's memberships before any organization is
bound (identity context). The tenant policy showed custom roles only inside their organization, so the
membership join silently dropped every membership on a custom role.

A separate permissive ``FOR SELECT`` policy: reads gain the holder's own roles, while INSERT/UPDATE/DELETE
stay governed by the unchanged tenant policy alone. Grants (``authz_rolepermission``) stay organization-only;
``build_actor`` reads them inside the member's organization.
"""

from django.db import migrations

from apps.core.rls import USER_SETTING

FORWARD = f"""
CREATE POLICY role_holder_read ON authz_role FOR SELECT
    USING (id IN (SELECT role_id FROM accounts_membership WHERE user_id = {USER_SETTING}));
"""
BACKWARD = "DROP POLICY IF EXISTS role_holder_read ON authz_role;"


class Migration(migrations.Migration):
    dependencies = [("authz", "0005_hierarchy_field_permissions_rls"), ("accounts", "0006_membership_hierarchy_role")]

    operations = [migrations.RunSQL(FORWARD, reverse_sql=BACKWARD)]
