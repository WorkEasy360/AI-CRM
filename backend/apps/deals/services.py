"""Deal lifecycle. Stage moves are the security-critical path: locked, versioned, historised, audited."""

from __future__ import annotations

import uuid
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from django.db import transaction
from django.db.models import F, Q, Sum
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from apps.audit import service as audit
from apps.authz import fields as field_rules
from apps.authz.actor import Actor
from apps.authz.service import check, scope
from apps.contacts.models import Contact
from apps.core import validators
from apps.core.domain_events import RecordChanged, publish
from apps.core.exceptions import ConflictError, DomainError
from apps.crm import records
from apps.crm.records import RecordSpec
from apps.dashboards import cache as dashboard_cache
from apps.deals.models import Deal, DealConnection, DealContact, DealProduct, DealStageHistory
from apps.pipelines import transitions
from apps.pipelines.models import Pipeline, PipelineStage
from apps.products.models import PriceBook, PriceBookEntry, Product

SPEC = RecordSpec(
    module="deals", entity_type="deal", model=Deal, display=lambda d: d.name, reassign_permission="deals.reassign"
)
MAX_LINES_PER_DEAL = 100
MAX_CONTACTS_PER_DEAL = 50
MAX_CONNECTIONS_PER_DEAL = 20
# Line fields a permission set may restrict (field-rule module "deal_line").
LINE_FIELDS = ("quantity", "unit_price", "discount_percent", "tax_rate")
CENT = Decimal("0.01")


def compute_amount_base(amount: Decimal, exchange_rate: Decimal) -> Decimal:
    return (amount * exchange_rate).quantize(CENT, rounding=ROUND_HALF_UP)


def weighted_amount(amount_base: Decimal, probability: int) -> Decimal:
    """Deal value x probability (the forecast contribution), rounded to the cent."""
    return (Decimal(amount_base or 0) * Decimal(int(probability or 0)) / Decimal(100)).quantize(
        CENT, rounding=ROUND_HALF_UP
    )


def _status_for(stage: PipelineStage) -> str:
    if stage.kind == PipelineStage.Kind.WON:
        return Deal.Status.WON
    if stage.kind == PipelineStage.Kind.LOST:
        return Deal.Status.LOST
    return Deal.Status.OPEN


def _active_stage(pipeline: Pipeline, stage: PipelineStage | None) -> PipelineStage:
    """Resolve the stage for a pipeline: the given one (must belong to it) or the first open stage."""
    if stage is not None:
        if stage.pipeline_id != pipeline.pk or stage.archived_at is not None:
            raise ValidationError({"stage_id": "Stage does not belong to this pipeline."})
        return stage
    first = (
        PipelineStage.objects.filter(pipeline=pipeline, archived_at__isnull=True, kind=PipelineStage.Kind.OPEN)
        .order_by("position")
        .first()
    )
    if first is None:
        raise DomainError("This pipeline has no open stage.", code="pipeline_no_open_stage")
    return first


def _stage_fields(
    stage: PipelineStage, now: Any, *, lost_reason: str | None, current_lost_reason: str = ""
) -> dict[str, Any]:
    """Fields derived from the stage a deal is in (status, probability, closed_at, lost_reason)."""
    status = _status_for(stage)
    fields: dict[str, Any] = {
        "stage": stage,
        "stage_entered_at": now,
        "status": status,
        "probability": stage.default_probability,
        "probability_overridden": False,
        "closed_at": None if status == Deal.Status.OPEN else now,
        "lost_reason": "",
    }
    if status == Deal.Status.LOST:
        fields["lost_reason"] = validators.clean_text(lost_reason or current_lost_reason, max_length=255)
    return fields


def _assert_pipeline_access(actor: Actor, pipeline: Pipeline) -> None:
    from apps.pipelines.access import can_access

    if not can_access(actor, pipeline.pk):
        raise ValidationError({"pipeline_id": "Unknown pipeline."})


def _assert_price_book(price_book: PriceBook, currency: str) -> None:
    if price_book.archived_at is not None or not price_book.is_active:
        raise ValidationError({"price_book_id": "Price book is not active."})
    if price_book.currency != currency:
        raise ValidationError({"price_book_id": f"Price book is in {price_book.currency}; the deal is in {currency}."})


@transaction.atomic
def create_deal(actor: Actor, data: dict[str, Any], *, request: Any = None) -> Deal:
    pipeline: Pipeline | None = data.pop("pipeline", None)
    if pipeline is None:
        pipeline = (
            Pipeline.objects.filter(archived_at__isnull=True, is_default=True).first()
            or Pipeline.objects.filter(archived_at__isnull=True).first()
        )
        if pipeline is None:
            raise DomainError("Create a pipeline first.", code="no_pipeline")
    if pipeline.archived_at is not None:
        raise ValidationError({"pipeline_id": "Pipeline is archived."})
    _assert_pipeline_access(actor, pipeline)
    stage = _active_stage(pipeline, data.pop("stage", None))
    now = timezone.now()
    data["pipeline"] = pipeline
    data.setdefault("currency", actor.organization.base_currency)
    data.setdefault("amount", Decimal("0.00"))
    if data.get("exchange_rate") is None:
        data["exchange_rate"] = Decimal("1")
    data["amount_base"] = compute_amount_base(data["amount"], data["exchange_rate"])
    if data.get("price_book") is not None:
        _assert_price_book(data["price_book"], data["currency"])
    probability = data.pop("probability", None)
    lost_reason = data.pop("lost_reason", "")
    data.update(_stage_fields(stage, now, lost_reason=lost_reason))
    if probability is not None and data["status"] == Deal.Status.OPEN and probability != stage.default_probability:
        data["probability"] = probability
        data["probability_overridden"] = True
    deal = records.create(
        actor, SPEC, data, request=request, audit_extra={"pipeline_id": str(pipeline.pk), "stage_id": str(stage.pk)}
    )
    transitions.validate(
        transitions.StageTransition(
            actor=actor, deal=deal, from_stage=None, to_stage=stage, source=DealStageHistory.Source.USER
        )
    )
    DealStageHistory.objects.create(
        deal=deal,
        from_stage=None,
        to_stage=stage,
        changed_by=actor.membership,
        changed_at=now,
        source=DealStageHistory.Source.USER,
    )
    return deal


@transaction.atomic
def update_deal(
    actor: Actor, deal: Deal, data: dict[str, Any], *, expected_version: int | None, request: Any = None
) -> Deal:
    """General field updates. Pipeline/stage changes are routed through ``move_stage`` for history."""
    new_pipeline = data.pop("pipeline", None)
    new_stage = data.pop("stage", None)
    if new_pipeline is not None and new_pipeline.pk != deal.pipeline_id:
        raise ValidationError({"pipeline_id": "Use the stage endpoint to move a deal to another pipeline."})
    if new_stage is not None and new_stage.pk != deal.stage_id:
        raise ValidationError({"stage_id": "Use the stage endpoint to change the stage."})
    if "probability" in data and deal.status != Deal.Status.OPEN:
        data.pop("probability")
    if "probability" in data:
        # A manual value that differs from the stage default is an override; setting it back to the
        # default clears the override.
        stage_default = (
            PipelineStage.objects.filter(pk=deal.stage_id).values_list("default_probability", flat=True).first()
        )
        data["probability_overridden"] = data["probability"] != stage_default
    if "lost_reason" in data and deal.status != Deal.Status.LOST:
        data.pop("lost_reason")
    if "amount" in data and deal.amount_from_lines and data["amount"] != deal.amount:
        raise DomainError(
            "This deal's amount is the total of its product lines. Change the lines instead.",
            code="amount_from_lines",
            status_code=409,
        )
    if "currency" in data and data["currency"] != deal.currency and deal.lines.exists():
        raise DomainError(
            "Remove the product lines before changing the deal currency.", code="deal_has_lines", status_code=409
        )
    if data.get("price_book") is not None and data["price_book"].pk != deal.price_book_id:
        _assert_price_book(data["price_book"], data.get("currency", deal.currency))
    amount = data.get("amount", deal.amount)
    rate = data.get("exchange_rate", deal.exchange_rate)
    if rate is None:
        rate = data["exchange_rate"] = Decimal("1")
    if "amount" in data or "exchange_rate" in data:
        data["amount_base"] = compute_amount_base(amount, rate)
    return records.update(actor, SPEC, deal, data, expected_version=expected_version, request=request)


@transaction.atomic
def move_stage(
    actor: Actor,
    deal_id: uuid.UUID,
    *,
    stage_id: uuid.UUID,
    expected_version: int,
    lost_reason: str | None = None,
    source: str = DealStageHistory.Source.USER,
    request: Any = None,
) -> Deal:
    """Move a deal to another stage of its pipeline.

    Protection layers: row lock (``select_for_update``) so concurrent moves serialise; the version the
    client saw must equal the locked row's version (409 otherwise); object-level ``deals.change_stage``
    on the locked row; the target stage must belong to the deal's pipeline; the UPDATE is additionally
    guarded by ``version`` so even a lost lock could not double-apply; history row and audit event are
    written in the same transaction.
    """
    # Lock the deal row alone. Joining the stage here would make PostgreSQL's re-check after a
    # concurrent stage change (EvalPlanQual) drop the row, because the join is re-evaluated against
    # the previously read stage tuple. Related rows are loaded after the lock is held.
    deal = Deal.objects.select_for_update(of=("self",)).filter(pk=deal_id).first()
    if deal is None:
        raise DomainError("Deal not found.", code="deal_not_found", status_code=404)
    deal.stage = PipelineStage.objects.get(pk=deal.stage_id)
    check(actor, "deals.change_stage", deal)
    if deal.archived_at is not None:
        raise DomainError("Restore the deal before moving it.", code="record_archived", status_code=409)
    if expected_version != deal.version:
        raise ConflictError("The deal was modified by someone else. Reload and try again.", code="version_conflict")
    stage = PipelineStage.objects.filter(pk=stage_id, pipeline_id=deal.pipeline_id, archived_at__isnull=True).first()
    if stage is None:
        raise ValidationError({"stage_id": "Stage does not belong to this deal's pipeline."})
    if stage.pk == deal.stage_id:
        return deal
    # The one place every stage change passes: M5 transition rules plug in here (apps.pipelines.transitions).
    transitions.validate(
        transitions.StageTransition(
            actor=actor, deal=deal, from_stage=deal.stage, to_stage=stage, source=source, lost_reason=lost_reason
        )
    )
    dashboard_cache.invalidate(actor.organization.pk)
    now = timezone.now()
    from_stage = deal.stage
    duration = now - deal.stage_entered_at if deal.stage_entered_at else None
    fields = _stage_fields(stage, now, lost_reason=lost_reason, current_lost_reason=deal.lost_reason)
    updated = Deal.objects.filter(pk=deal.pk, version=expected_version).update(
        **fields, updated_by=actor.membership, updated_at=now, version=expected_version + 1
    )
    for name, value in fields.items():
        setattr(deal, name, value)
    if updated != 1:  # pragma: no cover - the row lock makes this unreachable, kept as a hard stop
        raise ConflictError("The deal was modified by someone else. Reload and try again.", code="version_conflict")
    deal.version = expected_version + 1
    deal.updated_at = now
    # The stage move is a QuerySet.update(): no post_save fires, so webhooks and the knowledge index
    # would never hear about the single most important event in the pipeline without this.
    publish(
        RecordChanged(
            organization_id=deal.organization_id,
            entity_type="deal",
            entity_ids=(deal.pk,),
            change="stage_changed",
            owner_id=deal.owner_id,
            fields=tuple(sorted(fields)),
        )
    )
    DealStageHistory.objects.create(
        deal=deal,
        from_stage=from_stage,
        to_stage=stage,
        changed_by=actor.membership,
        changed_at=now,
        duration_in_previous_stage=duration,
        source=source,
    )
    audit.record(
        "deals.stage_changed",
        request=request,
        user=actor.user,
        resource=deal,
        resource_type="deal",
        metadata={
            "from_stage_id": str(from_stage.pk),
            "to_stage_id": str(stage.pk),
            "status": deal.status,
            "source": source,
        },
    )
    if deal.status == Deal.Status.WON:
        _promote_customers(actor, deal, request=request)
    return deal


def _promote_customers(actor: Actor, deal: Deal, *, request: Any = None) -> None:
    """Closed won: the company, the primary contact and every linked contact become customers."""
    from apps.companies.models import Company
    from apps.lifecycle import service as lifecycle

    records_to_promote: list[Any] = []
    if deal.company_id:
        records_to_promote.append(Company.objects.filter(pk=deal.company_id).first())
    contact_ids: set[uuid.UUID] = set(DealContact.objects.filter(deal=deal).values_list("contact_id", flat=True))
    if deal.primary_contact_id is not None:
        contact_ids.add(deal.primary_contact_id)
    records_to_promote.extend(Contact.objects.filter(pk__in=contact_ids))
    lifecycle.promote_on_won(actor, records_to_promote, deal_name=deal.name, request=request)


# ----------------------------------------------------------------------------- product lines


def line_amounts(
    quantity: Decimal, unit_price: Decimal, discount_percent: Decimal, tax_rate: Decimal
) -> tuple[Decimal, Decimal, Decimal]:
    """(subtotal, tax, total) of one line. Tax is charged on the discounted subtotal; each is rounded once."""
    gross = quantity * unit_price
    subtotal = (gross * (Decimal(100) - discount_percent) / Decimal(100)).quantize(CENT, rounding=ROUND_HALF_UP)
    tax = (subtotal * tax_rate / Decimal(100)).quantize(CENT, rounding=ROUND_HALF_UP)
    return subtotal, tax, subtotal + tax


def _assert_lines_writable(actor: Actor, changes: dict[str, Any]) -> None:
    """Line fields obey their own field rules ("deal_line"), and lines move the deal amount, so a
    permission set that may not change (or see) ``amount`` may not change lines either."""
    field_rules.assert_writable(actor, "deal_line", {k: v for k, v in changes.items() if k in LINE_FIELDS})
    if "amount" in actor.field_rules.get("deal", {}):
        raise PermissionDenied(detail="You cannot change: amount.", code="field_read_only")


def _lock_deal(actor: Actor, deal: Deal, expected_version: int | None) -> Deal:
    locked = Deal.objects.select_for_update(of=("self",)).filter(pk=deal.pk).first()
    if locked is None:
        raise DomainError("Deal not found.", code="deal_not_found", status_code=404)
    check(actor, "deals.update", locked)
    if locked.archived_at is not None:
        raise DomainError("Restore the deal first.", code="record_archived", status_code=409)
    if expected_version is not None and expected_version != locked.version:
        raise ConflictError("The deal was modified by someone else. Reload and try again.", code="version_conflict")
    return locked


def _lines_changed(actor: Actor, deal: Deal, *, action: str, metadata: dict[str, Any], request: Any) -> Deal:
    """After any line change: recompute the amount from the lines, bump the version, announce, audit."""
    agg = DealProduct.objects.filter(deal=deal).aggregate(total=Sum("line_total"))
    now = timezone.now()
    update: dict[str, Any] = {"updated_at": now, "updated_by": actor.membership, "version": F("version") + 1}
    changed = ["lines", "version"]
    if agg["total"] is not None:
        amount = agg["total"]
        update.update(
            amount=amount, amount_base=compute_amount_base(amount, deal.exchange_rate), amount_from_lines=True
        )
        changed += ["amount", "amount_base"]
    else:
        update["amount_from_lines"] = False
    Deal.objects.filter(pk=deal.pk).update(**update)
    # Not refresh_from_db(fields=...): a deferred organization_id makes TenantModel.__init__ recurse.
    fresh = Deal.objects.filter(pk=deal.pk).values(
        "amount", "amount_base", "amount_from_lines", "version", "updated_at"
    )[0]
    for name, value in fresh.items():
        setattr(deal, name, value)
    dashboard_cache.invalidate(actor.organization.pk)
    publish(
        RecordChanged(
            organization_id=deal.organization_id,
            entity_type="deal",
            entity_ids=(deal.pk,),
            change="updated",
            owner_id=deal.owner_id,
            fields=tuple(sorted(changed)),
        )
    )
    audit.record(
        f"deals.{action}",
        request=request,
        user=actor.user,
        resource=deal,
        resource_type="deal",
        metadata={**metadata, "amount": str(deal.amount), "amount_from_lines": deal.amount_from_lines},
    )
    return deal


def price_for(deal: Deal, product: Product) -> Decimal:
    """The unit price a new line starts with: the deal's price book entry, else the product's list price."""
    if deal.price_book_id:
        entry = PriceBookEntry.objects.filter(price_book_id=deal.price_book_id, product=product).first()
        if entry is not None:
            return entry.unit_price
    return product.unit_price


@transaction.atomic
def add_product(
    actor: Actor,
    deal: Deal,
    *,
    product: Product,
    quantity: Decimal,
    unit_price: Decimal | None = None,
    discount_percent: Decimal = Decimal(0),
    tax_rate: Decimal | None = None,
    expected_version: int | None = None,
    request: Any = None,
) -> DealProduct:
    _assert_lines_writable(
        actor,
        {
            "quantity": quantity,
            **({"unit_price": unit_price} if unit_price is not None else {}),
            **({"discount_percent": discount_percent} if discount_percent else {}),
            **({"tax_rate": tax_rate} if tax_rate is not None else {}),
        },
    )
    deal = _lock_deal(actor, deal, expected_version)
    if product.archived_at is not None or product.status != Product.Status.ACTIVE:
        raise ValidationError({"product_id": "Product is not active."})
    if DealProduct.objects.filter(deal=deal).count() >= MAX_LINES_PER_DEAL:
        raise DomainError(f"At most {MAX_LINES_PER_DEAL} product lines per deal.", code="deal_lines_limit")
    if DealProduct.objects.filter(deal=deal, product=product).exists():
        raise ConflictError("This product is already on the deal.", code="deal_product_exists")
    price = validators.clean_amount(unit_price if unit_price is not None else price_for(deal, product)) or Decimal(
        "0.00"
    )
    rate = tax_rate if tax_rate is not None else product.tax_rate
    subtotal, tax, total = line_amounts(quantity, price, discount_percent, rate)
    line = DealProduct.objects.create(
        deal=deal,
        product=product,
        quantity=quantity,
        unit_price=price,
        currency=deal.currency,
        discount_percent=discount_percent,
        tax_rate=rate,
        subtotal=subtotal,
        tax_amount=tax,
        line_total=total,
    )
    _lines_changed(
        actor,
        deal,
        action="product_added",
        metadata={"product_id": str(product.pk), "line_id": str(line.pk), "line_total": str(total)},
        request=request,
    )
    return line


@transaction.atomic
def update_product_line(
    actor: Actor,
    deal: Deal,
    line: DealProduct,
    *,
    expected_version: int | None = None,
    request: Any = None,
    **changes: Any,
) -> DealProduct:
    if line.deal_id != deal.pk:
        from django.http import Http404

        raise Http404
    changes = {f: changes[f] for f in LINE_FIELDS if changes.get(f) is not None}
    _assert_lines_writable(actor, changes)
    deal = _lock_deal(actor, deal, expected_version)
    before = {f: str(getattr(line, f)) for f in changes}
    for f, value in changes.items():
        setattr(line, f, value)
    line.subtotal, line.tax_amount, line.line_total = line_amounts(
        line.quantity, line.unit_price, line.discount_percent, line.tax_rate
    )
    line.save(
        update_fields=[
            "quantity",
            "unit_price",
            "discount_percent",
            "tax_rate",
            "subtotal",
            "tax_amount",
            "line_total",
            "updated_at",
        ]
    )
    _lines_changed(
        actor,
        deal,
        action="product_updated",
        metadata={"line_id": str(line.pk), "before": before, "after": {f: str(getattr(line, f)) for f in changes}},
        request=request,
    )
    return line


@transaction.atomic
def remove_product(
    actor: Actor, deal: Deal, line: DealProduct, *, expected_version: int | None = None, request: Any = None
) -> None:
    if line.deal_id != deal.pk:
        from django.http import Http404

        raise Http404
    _assert_lines_writable(actor, {})
    deal = _lock_deal(actor, deal, expected_version)
    line_id, product_id = line.pk, line.product_id
    line.delete()
    _lines_changed(
        actor,
        deal,
        action="product_removed",
        metadata={"line_id": str(line_id), "product_id": str(product_id)},
        request=request,
    )


# ----------------------------------------------------------------------------- contacts


@transaction.atomic
def add_contact(
    actor: Actor, deal: Deal, *, contact: Contact, role_label: str = "", request: Any = None
) -> DealContact:
    check(actor, "deals.update", deal)
    if contact.archived_at is not None:
        raise ValidationError({"contact_id": "Contact is archived."})
    if DealContact.objects.filter(deal=deal).count() >= MAX_CONTACTS_PER_DEAL:
        raise DomainError(f"At most {MAX_CONTACTS_PER_DEAL} contacts per deal.", code="deal_contacts_limit")
    link, created = DealContact.objects.get_or_create(
        deal=deal, contact=contact, defaults={"role_label": validators.clean_text(role_label, max_length=60)}
    )
    if created:
        audit.record(
            "deals.contact_added",
            request=request,
            user=actor.user,
            resource=deal,
            resource_type="deal",
            metadata={"contact_id": str(contact.pk)},
        )
    return link


@transaction.atomic
def remove_contact(actor: Actor, deal: Deal, *, contact_id: uuid.UUID, request: Any = None) -> None:
    check(actor, "deals.update", deal)
    deleted, _ = DealContact.objects.filter(deal=deal, contact_id=contact_id).delete()
    if deleted:
        audit.record(
            "deals.contact_removed",
            request=request,
            user=actor.user,
            resource=deal,
            resource_type="deal",
            metadata={"contact_id": str(contact_id)},
        )


# ----------------------------------------------------------------------------- connected deals


def _announce_link(actor: Actor, deals: list[Deal], change: str) -> None:
    for d in deals:
        others = tuple(("deal", str(o.pk)) for o in deals if o.pk != d.pk)
        publish(
            RecordChanged(
                organization_id=d.organization_id,
                entity_type="deal",
                entity_ids=(d.pk,),
                change=change,
                owner_id=d.owner_id,
                fields=("connections",),
                related=others,
            )
        )


@transaction.atomic
def connect_deals(
    actor: Actor,
    source: Deal,
    target: Deal,
    *,
    origin: str = DealConnection.Origin.MANUAL,
    request: Any = None,
) -> DealConnection:
    """Link two deals (shown on both). Needs edit rights on ``source`` and sight of ``target``."""
    check(actor, "deals.update", source)
    if not scope(actor, "deals.view", Deal.objects.filter(pk=target.pk)).exists():
        raise ValidationError({"target_id": "Unknown deal."})
    if source.pk == target.pk:
        raise ValidationError({"target_id": "A deal cannot be connected to itself."})
    if source.archived_at is not None or target.archived_at is not None:
        raise DomainError("Restore the deal first.", code="record_archived", status_code=409)
    pair = Q(source=source, target=target) | Q(source=target, target=source)
    if DealConnection.objects.filter(pair).exists():
        raise ConflictError("These deals are already connected.", code="deal_connection_exists")
    for d in (source, target):
        if DealConnection.objects.filter(Q(source=d) | Q(target=d)).count() >= MAX_CONNECTIONS_PER_DEAL:
            raise DomainError(
                f"A deal can have at most {MAX_CONNECTIONS_PER_DEAL} connected deals.", code="deal_connection_limit"
            )
    link = DealConnection.objects.create(source=source, target=target, origin=origin, created_by=actor.membership)
    _announce_link(actor, [source, target], "linked")
    audit.record(
        "deals.connected",
        request=request,
        user=actor.user,
        resource=source,
        resource_type="deal",
        metadata={"connection_id": str(link.pk), "target_id": str(target.pk), "origin": origin},
    )
    return link


@transaction.atomic
def disconnect_deals(actor: Actor, deal: Deal, connection: DealConnection, *, request: Any = None) -> None:
    check(actor, "deals.update", deal)
    if deal.pk not in (connection.source_id, connection.target_id):
        from django.http import Http404

        raise Http404
    other_id = connection.target_id if connection.source_id == deal.pk else connection.source_id
    connection_id = connection.pk
    connection.delete()
    _announce_link(actor, list(Deal.objects.filter(pk__in=[deal.pk, other_id])), "unlinked")
    audit.record(
        "deals.disconnected",
        request=request,
        user=actor.user,
        resource=deal,
        resource_type="deal",
        metadata={"connection_id": str(connection_id), "other_id": str(other_id)},
    )


def connections_for(actor: Actor, deal: Deal) -> list[dict[str, Any]]:
    """Both directions, as seen from ``deal``. The other deal is listed only if the actor may view it."""
    links = list(DealConnection.objects.filter(Q(source=deal) | Q(target=deal)).select_related("created_by__user"))
    other_ids = {lk.target_id if lk.source_id == deal.pk else lk.source_id for lk in links}
    visible = {
        d.pk: d
        for d in scope(actor, "deals.view", Deal.objects.filter(pk__in=other_ids)).select_related(
            "pipeline", "stage", "owner__user"
        )
    }
    out = []
    for lk in links:
        other_id = lk.target_id if lk.source_id == deal.pk else lk.source_id
        other = visible.get(other_id)
        if other is None:
            continue
        out.append(
            {
                "id": lk.pk,
                "direction": "outgoing" if lk.source_id == deal.pk else "incoming",
                "origin": lk.origin,
                "created_at": lk.created_at,
                "deal": other,
            }
        )
    return out


@transaction.atomic
def create_connected_deal(
    actor: Actor,
    source: Deal,
    *,
    pipeline: Pipeline,
    stage: PipelineStage | None = None,
    name: str | None = None,
    copy_fields: tuple[str, ...] = ("company", "primary_contact", "owner", "expected_close_date"),
    origin: str = DealConnection.Origin.AUTOMATION,
    request: Any = None,
) -> Deal:
    """Hook for the Milestone 5 workflow engine ("on stage X, create a deal in pipeline Y").

    Creates a deal in ``pipeline`` through the ordinary create path (permissions, plan limit, audit,
    events, transition hook) and connects it to ``source``. Not exposed as an endpoint in M2: the M5
    action calls it; manual linking of existing deals uses ``connect_deals``.
    """
    check(actor, "deals.view", source)
    data: dict[str, Any] = {"name": validators.clean_text(name or source.name, max_length=160), "pipeline": pipeline}
    if stage is not None:
        data["stage"] = stage
    for f in copy_fields:
        if f in {"company", "primary_contact", "owner", "expected_close_date", "description"}:
            value = getattr(source, f)
            if value is not None:
                data[f] = value
    data["currency"] = source.currency
    deal = create_deal(actor, data, request=request)
    connect_deals(actor, source, deal, origin=origin, request=request)
    return deal
