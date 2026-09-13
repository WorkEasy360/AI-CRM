"""Seed the five system roles. Runs after RLS is enabled; NULL-organization rows pass the policy."""

from django.db import migrations

SYSTEM_ROLES = [
    ("owner", "Owner", "Full control including billing and organization deletion."),
    ("admin", "Admin", "Full data and user management. Cannot delete the organization or manage billing."),
    ("sales_manager", "Sales Manager", "Manages all sales records, pipelines' deals, reports and exports."),
    ("sales_rep", "Sales Representative", "Works own and team records."),
    ("viewer", "Viewer", "Read-only access to CRM records and reports."),
]


def seed_system_roles(apps, schema_editor):
    Role = apps.get_model("authz", "Role")
    for key, name, description in SYSTEM_ROLES:
        Role.objects.update_or_create(
            key=key, organization=None, defaults={"name": name, "description": description, "is_system": True}
        )


def unseed_system_roles(apps, schema_editor):
    Role = apps.get_model("authz", "Role")
    Role.objects.filter(organization=None, is_system=True, key__in=[k for k, _, _ in SYSTEM_ROLES]).delete()


class Migration(migrations.Migration):
    dependencies = [("authz", "0002_seed_roles_rls")]

    operations = [migrations.RunPython(seed_system_roles, unseed_system_roles)]
