"""Deal lifecycle. Stage moves are the security-critical path: locked, versioned, historised, audited."""

from __future__ import annotations

import uuid
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

from apps.audit import service as audit
from apps.authz.actor import Actor
from apps.authz.service import check
from apps.contacts.models import Contact
from apps.core import validators
from apps.core.domain_events import RecordChanged, publish
from apps.core.exceptions import ConflictError, DomainError
from apps.crm import records
from apps.crm.records import RecordSpec
from apps.dashboards import cache as dashboard_cache
from apps.deals.models import Deal, DealContact, DealProduct, DealStageHistory
from apps.pipelines.models import Pipeline, PipelineStage
from apps.products.models import Product

SPEC = RecordSpec(
    module="deals", entity_type="deal", model=Deal, display=lambda d: d.name, reassign_permission="deals.reassign"
)
MAX_LINES_PER_DEAL = 100
MAX_CONTACTS_PER_DEAL = 50
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
    stage = _active_stage(pipeline, data.pop("stage", None))
    now = timezone.now()
    data["pipeline"] = pipeline
    data.setdefault("currency", actor.organization.base_currency)
    data.setdefault("amount", Decimal("0.00"))
    if data.get("exchange_rate") is None:
        data["exchange_rate"] = Decimal("1")
    data["amount_base"] = compute_amount_base(data["amount"], data["exchange_rate"])
    probability = data.pop("probability", None)
    lost_reason = data.pop("lost_reason", "")
    data.update(_stage_fields(stage, now, lost_reason=lost_reason))
    if probability is not None and data["status"] == Deal.Status.OPEN and probability != stage.default_probability:
        data["probability"] = probability
        data["probability_overridden"] = True
    deal = records.create(
        actor, SPEC, data, request=request, audit_extra={"pipeline_id": str(pipeline.pk), "stage_id": str(stage.pk)}
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


def _line_total(quantity: Decimal, unit_price: Decimal, discount_percent: Decimal) -> Decimal:
    gross = quantity * unit_price
    net = gross * (Decimal(100) - discount_percent) / Decimal(100)
    return net.quantize(CENT, rounding=ROUND_HALF_UP)


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
    request: Any = None,
) -> DealProduct:
    check(actor, "deals.update", deal)
    if deal.archived_at is not None:
        raise DomainError("Restore the deal first.", code="record_archived", status_code=409)
    if product.archived_at is not None or product.status != Product.Status.ACTIVE:
        raise ValidationError({"product_id": "Product is not active."})
    if DealProduct.objects.filter(deal=deal).count() >= MAX_LINES_PER_DEAL:
        raise DomainError(f"At most {MAX_LINES_PER_DEAL} product lines per deal.", code="deal_lines_limit")
    if DealProduct.objects.filter(deal=deal, product=product).exists():
        raise ConflictError("This product is already on the deal.", code="deal_product_exists")
    price = validators.clean_amount(unit_price if unit_price is not None else product.unit_price) or Decimal("0.00")
    rate = tax_rate if tax_rate is not None else product.tax_rate
    line = DealProduct.objects.create(
        deal=deal,
        product=product,
        quantity=quantity,
        unit_price=price,
        currency=deal.currency,
        discount_percent=discount_percent,
        tax_rate=rate,
        line_total=_line_total(quantity, price, discount_percent),
    )
    Deal.objects.filter(pk=deal.pk).update(updated_at=timezone.now(), updated_by=actor.membership)
    audit.record(
        "deals.product_added",
        request=request,
        user=actor.user,
        resource=deal,
        resource_type="deal",
        metadata={"product_id": str(product.pk), "line_id": str(line.pk)},
    )
    return line


@transaction.atomic
def update_product_line(
    actor: Actor, deal: Deal, line: DealProduct, *, request: Any = None, **changes: Any
) -> DealProduct:
    check(actor, "deals.update", deal)
    if line.deal_id != deal.pk:
        from django.http import Http404

        raise Http404
    for f in ("quantity", "unit_price", "discount_percent", "tax_rate"):
        if changes.get(f) is not None:
            setattr(line, f, changes[f])
    line.line_total = _line_total(line.quantity, line.unit_price, line.discount_percent)
    line.save(update_fields=["quantity", "unit_price", "discount_percent", "tax_rate", "line_total", "updated_at"])
    audit.record(
        "deals.product_updated",
        request=request,
        user=actor.user,
        resource=deal,
        resource_type="deal",
        metadata={"line_id": str(line.pk)},
    )
    return line


@transaction.atomic
def remove_product(actor: Actor, deal: Deal, line: DealProduct, *, request: Any = None) -> None:
    check(actor, "deals.update", deal)
    if line.deal_id != deal.pk:
        from django.http import Http404

        raise Http404
    line_id = line.pk
    line.delete()
    audit.record(
        "deals.product_removed",
        request=request,
        user=actor.user,
        resource=deal,
        resource_type="deal",
        metadata={"line_id": str(line_id)},
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
