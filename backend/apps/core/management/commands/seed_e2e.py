"""Seed a fresh organization with the members the browser E2E suites expect (never against production).

    python manage.py seed_e2e --out ../frontend/test-results/e2e-users.json

Writes ``{"password", "owner", "viewer", "rep", "mfa"}`` for ``E2E_USERS_FILE`` (see
``frontend/tests/e2e/helpers.ts``). Every run creates a new organization so suites never see each
other's records; emails are verified so the login flow needs no mailbox.
"""

from __future__ import annotations

import json
import secrets
import uuid
from pathlib import Path

from allauth.account.models import EmailAddress
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.accounts import services as account_services
from apps.accounts.models import Membership, User
from apps.authz.models import Role
from apps.core.tenancy.context import system_context, tenant_context

MEMBERS = (("viewer", "Victor", "viewer"), ("rep", "Rita", "sales_rep"), ("mfa", "Mia", "sales_manager"))


class Command(BaseCommand):
    help = "Seed an organization with owner, viewer, sales rep and MFA-candidate users for browser E2E runs."

    def add_arguments(self, parser):
        parser.add_argument("--out", required=True, help="Where to write the users JSON")
        parser.add_argument("--password", default=None, help="Shared password (random when omitted)")
        parser.add_argument("--domain", default="e2e.keel.test")

    def handle(self, *args, **options):
        if settings.ENVIRONMENT == "production":
            raise CommandError("Never seed E2E users against production.")
        suffix = uuid.uuid4().hex[:6]
        password = options["password"] or f"E2e-{secrets.token_urlsafe(12)}!"
        domain = options["domain"]

        def user(email: str, first_name: str) -> User:
            with system_context("seed_e2e.user"):
                created = User.objects.create_user(email=email, password=password, first_name=first_name)
                EmailAddress.objects.create(user=created, email=email, verified=True, primary=True)
            return created

        owner_email = f"owner-{suffix}@{domain}"
        owner = user(owner_email, "Olivia")
        with transaction.atomic():
            membership = account_services.create_organization(
                owner, name=f"E2E Org {suffix}", base_currency="USD", timezone_name="UTC"
            )
        result = {"org_id": str(membership.organization_id), "password": password, "owner": owner_email}
        with tenant_context(
            membership.organization_id, user_id=owner.pk, membership_id=membership.pk, reason="seed_e2e"
        ):
            for key, first_name, role_key in MEMBERS:
                email = f"{key}-{suffix}@{domain}"
                member = user(email, first_name)
                role = Role.objects.get(key=role_key, is_system=True, organization__isnull=True)
                Membership.objects.create(user=member, role=role)
                result[key] = email
        out = Path(options["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(result, indent=2), encoding="utf-8")
        self.stdout.write(f"seeded {result['org_id']} -> {out}")
