"""``move_workeasy360_issuer``: Keel's identity links follow WorkEasy360's move to accounts.workeasy360.com.

Keel links people on (issuer, sub) twice - ``ExternalIdentity`` (authoritative) and the connector's mirror -
so both move together, in one transaction, or neither does. Proven here on the real tables; the connector's
own suite proves the sign-in end to end (the same person, the same account, after the move).
"""

from __future__ import annotations

import io
import uuid

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError
from workeasy360_sso.models import FederatedIdentity, ProductSession

from apps.accounts.models import ExternalIdentity, User
from apps.audit.models import AuditEvent
from apps.core.tenancy.context import system_context
from tests.accounts import workeasy360_fake as fake

pytestmark = [pytest.mark.django_db, pytest.mark.security]

OLD = "https://auth.workeasy360.test"
NEW = fake.ISSUER  # the configured WORKEASY360_ISSUER


@pytest.fixture
def configured(settings):
    return fake.configure(settings, fake.FakeProvider())


def _user(name: str) -> User:
    with system_context("test.setup"):
        return User.objects.create_user(email=f"{name}@example.com", password=None)


def _link(user: User, issuer: str, subject: str) -> None:
    """Both links, as a Keel sign-in leaves them."""
    with system_context("test.setup"):
        ExternalIdentity.objects.create(user=user, issuer=issuer, subject=subject)
        FederatedIdentity.objects.create(user=user, issuer=issuer, subject=subject)


def _run(*args: str) -> str:
    out = io.StringIO()
    call_command("move_workeasy360_issuer", *args, stdout=out)
    return out.getvalue()


def _issuers(model, subject: str) -> list[str]:
    with system_context("test.lookup"):
        return sorted(model.objects.filter(subject=subject).values_list("issuer", flat=True))


def test_a_dry_run_reports_both_tables_and_changes_nothing(configured):
    _link(_user("a"), OLD, "sub-a")
    out = _run("--from", OLD)
    assert "Keel identities" in out and "identities=1" in out
    assert "Connector mirror" in out and "dry run" in out
    assert _issuers(ExternalIdentity, "sub-a") == [OLD]
    assert _issuers(FederatedIdentity, "sub-a") == [OLD]


def test_apply_moves_both_links_and_is_audited_and_idempotent(configured):
    user = _user("a")
    _link(user, OLD, "sub-a")
    with system_context("test.setup"):
        session = ProductSession.objects.create(
            identity=FederatedIdentity.objects.get(subject="sub-a"),
            session_key="k1",
            organization_id=uuid.uuid4(),
        )

    assert "Moved 1 Keel identities" in _run("--from", OLD, "--apply")
    assert _issuers(ExternalIdentity, "sub-a") == [NEW]
    assert _issuers(FederatedIdentity, "sub-a") == [NEW]
    with system_context("test.lookup"):
        session.refresh_from_db()
        assert session.identity.issuer == NEW  # back-channel logout still finds it
        event = AuditEvent.objects.get(action="auth.sso_issuer_moved")
    assert event.metadata["from"] == OLD and event.metadata["to"] == NEW
    assert event.metadata["identities"] == 1

    assert "Moved 0 Keel identities" in _run("--from", OLD, "--apply")


def test_a_duplicate_link_of_the_same_person_and_account_is_folded(configured):
    user = _user("a")
    _link(user, OLD, "sub-a")
    _link(user, NEW, "sub-a")
    _run("--from", OLD, "--apply")
    assert _issuers(ExternalIdentity, "sub-a") == [NEW]
    assert _issuers(FederatedIdentity, "sub-a") == [NEW]


def test_one_person_on_two_keel_accounts_moves_nothing(configured):
    _link(_user("a"), OLD, "sub-a")
    _link(_user("b"), NEW, "sub-a")
    _link(_user("c"), OLD, "sub-c")

    assert "two Keel users" in _run("--from", OLD)
    with pytest.raises(CommandError, match="Nothing moved"):
        _run("--from", OLD, "--apply")
    assert _issuers(ExternalIdentity, "sub-c") == [OLD]
    assert _issuers(FederatedIdentity, "sub-c") == [OLD]


def test_a_mirror_conflict_undoes_the_keel_move_too(configured):
    """Keel's table is clean but the mirror is not: the whole move is rolled back."""
    _link(_user("a"), OLD, "sub-a")
    with system_context("test.setup"):
        FederatedIdentity.objects.create(user=_user("b"), issuer=NEW, subject="sub-a")

    with pytest.raises(CommandError):
        _run("--from", OLD, "--apply")
    assert _issuers(ExternalIdentity, "sub-a") == [OLD]
    with system_context("test.lookup"):
        assert not AuditEvent.objects.filter(action="auth.sso_issuer_moved").exists()


@pytest.mark.parametrize(
    ("previous", "message"),
    [(NEW, "already the configured issuer"), (f"{OLD}/", "trailing"), ("http://auth.workeasy360.test", "https")],
)
def test_it_refuses_a_source_it_cannot_trust(configured, previous, message):
    with pytest.raises(CommandError, match=message):
        _run("--from", previous)
