"""Tenant context, scoped managers and PostgreSQL RLS behave as designed (fail closed)."""

import pytest
from django.db import connection

from apps.core.exceptions import CrossTenantWriteError, ImmutableTenantError, TenantContextMissing, UnscopedAccessError
from apps.core.management.commands.rls_check import find_rls_gaps
from apps.core.tenancy.context import apply_db_context, get_context, system_context, tenant_context
from tests.testapp.models import Widget
from tests.testapp.tasks import count_widgets

pytestmark = pytest.mark.django_db


def _raw_count(table: str) -> int:
    with connection.cursor() as cur:
        cur.execute(f"SELECT count(*) FROM {table}")  # noqa: S608 - table names are constants in tests
        return cur.fetchone()[0]


def test_manager_requires_context(org_a):
    assert get_context() is None
    with pytest.raises(TenantContextMissing):
        Widget.objects.count()


def test_save_sets_organization_and_scopes_reads(org_a, org_b):
    with tenant_context(org_a.org.pk):
        w = Widget.objects.create(name="a")
        assert w.organization_id == org_a.org.pk
        assert Widget.objects.count() == 1
    with tenant_context(org_b.org.pk):
        assert Widget.objects.count() == 0


def test_organization_is_immutable(org_a, org_b, make_widget):
    w = make_widget(org_a)
    with tenant_context(org_a.org.pk):
        w = Widget.objects.get(pk=w.pk)
        w.organization = org_b.org
        with pytest.raises(ImmutableTenantError):
            w.save()


def test_cross_tenant_create_rejected(org_a, org_b):
    with tenant_context(org_a.org.pk), pytest.raises(CrossTenantWriteError):
        Widget.objects.create(name="x", organization=org_b.org)


def test_unscoped_manager_requires_system_context(org_a, make_widget):
    make_widget(org_a)
    with pytest.raises(UnscopedAccessError):
        Widget.all_objects.count()
    with tenant_context(org_a.org.pk), pytest.raises(UnscopedAccessError):
        Widget.all_objects.count()
    with system_context("test.unscoped"):
        assert Widget.all_objects.count() == 1


def test_system_context_requires_reason():
    with pytest.raises(ValueError), system_context(""):
        pass


def test_rls_blocks_raw_sql_without_context(org_a, org_b, make_widget):
    make_widget(org_a)
    make_widget(org_b)
    apply_db_context(None)
    assert _raw_count("testapp_widget") == 0
    assert _raw_count("accounts_membership") == 0
    assert _raw_count("accounts_organization") == 0
    assert _raw_count("audit_auditevent") == 0
    with tenant_context(org_a.org.pk):
        assert _raw_count("testapp_widget") == 1
        assert _raw_count("accounts_organization") == 1
    with system_context("test.rls"):
        assert _raw_count("testapp_widget") == 2


def test_rls_blocks_raw_insert_for_other_org(org_a, org_b):
    from django.db import DatabaseError, transaction

    with tenant_context(org_a.org.pk), pytest.raises(DatabaseError), transaction.atomic(), connection.cursor() as cur:
        cur.execute(
            "INSERT INTO testapp_widget (id, created_at, updated_at, name, organization_id)"
            " VALUES (gen_random_uuid(), now(), now(), 'evil', %s)",
            [str(org_b.org.pk)],
        )


def test_membership_visible_to_its_user_without_org(org_a):
    """Identity access: a user sees their own memberships once the user half of the context is set."""
    from django.db import transaction

    from apps.core.tenancy.context import set_db_user

    with transaction.atomic():
        apply_db_context(None)
        assert _raw_count("accounts_membership") == 0
        set_db_user(org_a.owner.pk)
        assert _raw_count("accounts_membership") == 1
        assert _raw_count("accounts_organization") == 1
        apply_db_context(None)


def test_every_tenant_table_has_forced_rls():
    assert find_rls_gaps() == []


def test_tenant_task_requires_organization(org_a, make_widget):
    make_widget(org_a)
    with pytest.raises(TenantContextMissing):
        count_widgets.apply(kwargs={}).get()
    assert count_widgets.apply(kwargs={"organization_id": str(org_a.org.pk)}).get() == 1


def test_context_is_restored_after_nested_binding(org_a, org_b, make_widget):
    make_widget(org_a)
    with tenant_context(org_a.org.pk):
        with tenant_context(org_b.org.pk):
            assert Widget.objects.count() == 0
        assert get_context().organization_id == org_a.org.pk
        assert Widget.objects.count() == 1
        assert _raw_count("testapp_widget") == 1
