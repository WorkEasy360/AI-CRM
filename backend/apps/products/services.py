"""Price books: named, single-currency price lists for products. Organization configuration (audited)."""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.service import check
from apps.core import validators
from apps.core.concurrency import save_with_version
from apps.core.exceptions import ConflictError
from apps.products.models import PriceBook, PriceBookEntry, Product

MAX_PRICE_BOOKS = 100
MAX_ENTRIES_PER_REQUEST = 500


def _clean_name(name: Any) -> str:
    value = validators.clean_text(name, max_length=80)
    if not value:
        raise ValidationError({"name": "Name is required."})
    return value


@transaction.atomic
def create_price_book(
    actor: Actor, *, name: str, currency: str, description: str = "", request: Any = None
) -> PriceBook:
    check(actor, "pricebooks.manage")
    name = _clean_name(name)
    if PriceBook.objects.filter(name__iexact=name).exists():
        raise ConflictError("A price book with this name already exists.", code="price_book_name_taken")
    if PriceBook.objects.filter(archived_at__isnull=True).count() >= MAX_PRICE_BOOKS:
        raise ValidationError({"name": f"At most {MAX_PRICE_BOOKS} price books."})
    book = PriceBook.objects.create(
        name=name,
        currency=validators.clean_currency(currency, default=actor.organization.base_currency),
        description=validators.clean_text(description, max_length=255),
    )
    audit.record(
        "pricebooks.created",
        request=request,
        user=actor.user,
        resource=book,
        metadata={"name": book.name, "currency": book.currency},
    )
    return book


@transaction.atomic
def update_price_book(
    actor: Actor, book: PriceBook, *, expected_version: int | None, request: Any = None, **changes: Any
) -> PriceBook:
    check(actor, "pricebooks.manage")
    before: dict[str, Any] = {}
    if changes.get("name") is not None:
        name = _clean_name(changes["name"])
        if name.lower() != book.name.lower() and PriceBook.objects.filter(name__iexact=name).exists():
            raise ConflictError("A price book with this name already exists.", code="price_book_name_taken")
        before["name"], book.name = book.name, name
    if changes.get("description") is not None:
        before["description"], book.description = (
            book.description,
            validators.clean_text(changes["description"], max_length=255),
        )
    if changes.get("is_active") is not None:
        before["is_active"], book.is_active = book.is_active, bool(changes["is_active"])
    if "currency" in changes and changes["currency"] and changes["currency"] != book.currency:
        raise ValidationError({"currency": "A price book's currency cannot change. Create a new one."})
    if before:
        save_with_version(book, expected_version, list(before))
        audit.record(
            "pricebooks.updated",
            request=request,
            user=actor.user,
            resource=book,
            metadata={"before": before, "after": {k: getattr(book, k) for k in before}},
        )
    return book


@transaction.atomic
def archive_price_book(actor: Actor, book: PriceBook, *, request: Any = None) -> None:
    check(actor, "pricebooks.manage")
    if book.archived_at is not None:
        return
    book.archived_at = timezone.now()
    save_with_version(book, None, ["archived_at"])
    audit.record("pricebooks.archived", request=request, user=actor.user, resource=book)


@transaction.atomic
def set_entries(
    actor: Actor, book: PriceBook, *, entries: list[dict[str, Any]], request: Any = None
) -> list[PriceBookEntry]:
    """Upsert prices for products. ``unit_price: null`` removes the product from the book."""
    check(actor, "pricebooks.manage")
    if len(entries) > MAX_ENTRIES_PER_REQUEST:
        raise ValidationError({"entries": f"At most {MAX_ENTRIES_PER_REQUEST} entries per request."})
    ids: list[uuid.UUID] = [e["product_id"] for e in entries]
    products = {p.pk: p for p in Product.objects.filter(pk__in=ids, archived_at__isnull=True)}
    if len(products) != len(set(ids)):
        raise ValidationError({"entries": "Unknown product."})
    changed: list[dict[str, Any]] = []
    for entry in entries:
        product = products[entry["product_id"]]
        price = entry.get("unit_price")
        existing = PriceBookEntry.objects.filter(price_book=book, product=product).first()
        if price is None:
            if existing is not None:
                changed.append({"product_id": str(product.pk), "before": str(existing.unit_price), "after": None})
                existing.delete()
            continue
        price = validators.clean_amount(price) or Decimal("0.00")
        if existing is None:
            PriceBookEntry.objects.create(price_book=book, product=product, unit_price=price)
            changed.append({"product_id": str(product.pk), "before": None, "after": str(price)})
        elif existing.unit_price != price:
            changed.append({"product_id": str(product.pk), "before": str(existing.unit_price), "after": str(price)})
            existing.unit_price = price
            existing.save(update_fields=["unit_price", "updated_at"])
    if changed:
        audit.record(
            "pricebooks.prices_changed",
            request=request,
            user=actor.user,
            resource=book,
            metadata={"changes": changed[:200], "count": len(changed)},
        )
    return list(PriceBookEntry.objects.filter(price_book=book).select_related("product"))
