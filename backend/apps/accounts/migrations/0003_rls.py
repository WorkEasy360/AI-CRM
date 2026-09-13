from django.db import migrations

from apps.core.rls import USER_SETTING, enable_rls


class Migration(migrations.Migration):
    dependencies = [("accounts", "0002_initial")]

    operations = [
        # The tenant root: visible when it is the bound organization or the current user belongs to it.
        enable_rls(
            "accounts_organization",
            column="id",
            extra=f"id IN (SELECT organization_id FROM accounts_membership WHERE user_id = {USER_SETTING})",
        ),
        # A user can always see their own memberships (login, session, organization switching).
        enable_rls("accounts_membership", extra=f"user_id = {USER_SETTING}"),
        enable_rls("accounts_invitation"),
    ]
