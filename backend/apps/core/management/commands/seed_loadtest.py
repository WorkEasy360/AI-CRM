"""Seed realistic multi-tenant data for load tests (never run against production).

Creates ``--small`` small organizations and ``--large`` large ones, each with an owner plus sales
representatives (own-scope) and a sales manager, verified emails, one shared password, and a body of
contacts, companies, products and deals spread over the default pipeline. Writes a ``users.json`` the
k6 suite reads. Idempotent per organization slug: re-running skips organizations that already exist.
"""

from __future__ import annotations

import json
import random
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

from allauth.account.models import EmailAddress
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from django.utils import timezone

from apps.accounts import services as account_services
from apps.accounts.models import Membership, Organization, User
from apps.authz.models import Role
from apps.companies.models import Company
from apps.contacts.models import Contact
from apps.core.tenancy.context import system_context, tenant_context
from apps.deals.models import Deal
from apps.pipelines.models import PipelineStage
from apps.pipelines.services import ensure_default_pipeline
from apps.products.models import Product

FIRST = ["Ada", "Grace", "Linus", "Ken", "Dennis", "Barbara", "Alan", "Radia", "Anita", "Guido", "Rohit", "Priya"]
LAST = ["Lovelace", "Hopper", "Torvalds", "Thompson", "Ritchie", "Liskov", "Kay", "Perlman", "Borg", "Sharma"]
COMPANIES = ["Acme", "Globex", "Initech", "Umbrella", "Hooli", "Vandelay", "Stark", "Wayne", "Tyrell", "Cyberdyne"]
INDUSTRIES = ["software", "manufacturing", "retail", "finance", "healthcare", "logistics"]
SOURCES = ["web", "referral", "event", "outbound", "partner"]
SIZES = {
    "small": {"companies": 100, "contacts": 300, "products": 30, "deals": 200},
    "large": {"companies": 5000, "contacts": 25000, "products": 500, "deals": 12000},
}
BATCH = 500


class Command(BaseCommand):
    help = "Seed load-test tenants and write the users file consumed by loadtest/k6."

    def add_arguments(self, parser):
        parser.add_argument("--small", type=int, default=5, help="Number of small organizations")
        parser.add_argument("--large", type=int, default=1, help="Number of large organizations")
        parser.add_argument("--reps", type=int, default=3, help="Sales representatives per organization")
        parser.add_argument("--password", default="LoadTest-Passw0rd-2026!")
        parser.add_argument("--out", default="../loadtest/users.json")
        parser.add_argument("--seed", type=int, default=42)

    def handle(self, *args, **options):
        if settings.ENVIRONMENT in {"production", "staging"}:
            raise CommandError("Refusing to seed load-test data in production or staging.")
        rng = random.Random(options["seed"])  # noqa: S311 # nosec B311 - synthetic data, not security
        password = options["password"]
        users: list[dict[str, str]] = []
        plan = [("small", i) for i in range(options["small"])] + [("large", i) for i in range(options["large"])]
        for size, index in plan:
            slug = f"lt-{size}-{index}"
            users.extend(self._seed_org(slug, size, rng, password, options["reps"]))
        with connection.cursor() as cur:
            cur.execute("ANALYZE")
        out = Path(options["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({"password": password, "users": users}, indent=2), encoding="utf-8")
        self.stdout.write(self.style.SUCCESS(f"Seeded {len(plan)} organizations, {len(users)} users -> {out}"))

    # ------------------------------------------------------------------ helpers
    def _user(self, email: str, password: str, first_name: str) -> User:
        user = User.objects.filter(email=email).first()
        if user is None:
            user = User.objects.create_user(email=email, password=password, first_name=first_name)
            EmailAddress.objects.create(user=user, email=email, verified=True, primary=True)
        return user

    def _ensure_members(self, org: Organization, entries: list[dict[str, str]], password: str) -> int:
        with system_context("seed_loadtest.members"):
            owner_membership = (
                Membership.all_objects.filter(organization=org, role__key="owner").select_related("user").first()
            )
        if owner_membership is None:
            return 0
        added = 0
        with tenant_context(org.pk, user_id=owner_membership.user_id, membership_id=owner_membership.pk, reason="seed"):
            for entry in entries[1:]:
                user = self._user(entry["email"], password, entry["role"].replace("_", " ").title())
                if Membership.objects.filter(user=user).exists():
                    continue
                role = Role.objects.get(key=entry["role"], is_system=True, organization__isnull=True)
                Membership.objects.create(user=user, role=role)
                added += 1
        return added

    def _seed_org(self, slug: str, size: str, rng: random.Random, password: str, reps: int) -> list[dict[str, str]]:
        owner_email = f"owner@{slug}.example.com"
        with system_context("seed_loadtest.lookup"):
            # Existing = the owner user already owns a load-test organization (the slug is set below,
            # inside the same system context, so RLS lets the UPDATE through).
            existing = (
                Organization._base_manager.filter(slug=slug).first()
                or Organization._base_manager.filter(
                    memberships__user__email=owner_email, memberships__role__key="owner"
                ).first()
            )
        entries = [{"email": owner_email, "org": slug, "size": size, "role": "owner"}]
        for i in range(reps):
            entries.append({"email": f"rep{i}@{slug}.example.com", "org": slug, "size": size, "role": "sales_rep"})
        entries.append({"email": f"manager@{slug}.example.com", "org": slug, "size": size, "role": "sales_manager"})
        if existing is not None:
            # Data stays as it is; only members listed in the users file but not yet present are added, so
            # a later run with a larger --reps can widen the user pool without reseeding records.
            added = self._ensure_members(existing, entries, password)
            self.stdout.write(f"{slug}: exists, skipping records ({added} members added)")
            return entries

        self.stdout.write(f"{slug}: creating ({size})")
        owner = self._user(owner_email, password, "Owner")
        with transaction.atomic():
            membership = account_services.create_organization(owner, name=f"Load {size} {slug[-1]}")
            org = membership.organization
            with system_context("seed_loadtest.slug"):
                Organization._base_manager.filter(pk=org.pk).update(slug=slug)
        members = [membership]
        with tenant_context(org.pk, user_id=owner.pk, membership_id=membership.pk, reason="seed_loadtest"):
            for entry in entries[1:]:
                role = Role.objects.get(key=entry["role"], is_system=True, organization__isnull=True)
                user = self._user(entry["email"], password, entry["role"].replace("_", " ").title())
                members.append(Membership.objects.create(user=user, role=role))
            pipeline = ensure_default_pipeline()
            stages = list(
                PipelineStage.objects.filter(pipeline=pipeline, archived_at__isnull=True).order_by("position")
            )
            counts = SIZES[size]
            now = timezone.now()

            companies = [
                Company(
                    organization_id=org.pk,
                    name=f"{rng.choice(COMPANIES)} {rng.choice(INDUSTRIES).title()} {i}",
                    website=f"https://{slug}-{i}.example.com",
                    industry=rng.choice(INDUSTRIES),
                    source=rng.choice(SOURCES),
                    owner=rng.choice(members),
                    created_by=membership,
                    updated_by=membership,
                )
                for i in range(counts["companies"])
            ]
            Company.objects.bulk_create(companies, batch_size=BATCH)
            company_ids = list(Company.objects.values_list("pk", flat=True))

            contacts = [
                Contact(
                    organization_id=org.pk,
                    first_name=rng.choice(FIRST),
                    last_name=f"{rng.choice(LAST)}{i}",
                    email=f"{rng.choice(FIRST).lower()}.{i}@{slug}.example.com",
                    phone=f"+91 9{rng.randint(100000000, 999999999)}",
                    job_title=rng.choice(["CEO", "CTO", "Buyer", "Engineer", "Manager"]),
                    company_id=rng.choice(company_ids),
                    source=rng.choice(SOURCES),
                    owner=rng.choice(members),
                    created_by=membership,
                    updated_by=membership,
                )
                for i in range(counts["contacts"])
            ]
            Contact.objects.bulk_create(contacts, batch_size=BATCH)
            contact_ids = list(Contact.objects.values_list("pk", flat=True))

            products = [
                Product(
                    organization_id=org.pk,
                    name=f"Plan {i}",
                    sku=f"SKU-{slug}-{i}",
                    unit_price=Decimal(rng.randint(100, 100000)),
                    currency=org.base_currency,
                    owner=membership,
                    created_by=membership,
                    updated_by=membership,
                )
                for i in range(counts["products"])
            ]
            Product.objects.bulk_create(products, batch_size=BATCH)

            deals = []
            for i in range(counts["deals"]):
                stage = rng.choice(stages)
                amount = Decimal(rng.randint(1000, 500000))
                entered = now - timedelta(days=rng.randint(0, 400))
                status = "open" if stage.kind == "open" else stage.kind
                deals.append(
                    Deal(
                        organization_id=org.pk,
                        name=f"Deal {i} {rng.choice(COMPANIES)}",
                        pipeline=pipeline,
                        stage=stage,
                        company_id=rng.choice(company_ids),
                        primary_contact_id=rng.choice(contact_ids),
                        amount=amount,
                        currency=org.base_currency,
                        exchange_rate=Decimal(1),
                        amount_base=amount,
                        probability=stage.default_probability,
                        status=status,
                        closed_at=entered if status != "open" else None,
                        stage_entered_at=entered,
                        expected_close_date=(entered + timedelta(days=30)).date(),
                        owner=rng.choice(members),
                        created_by=membership,
                        updated_by=membership,
                    )
                )
            Deal.objects.bulk_create(deals, batch_size=BATCH)
        return entries
