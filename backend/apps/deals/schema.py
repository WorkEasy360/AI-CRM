"""Deal fields as data (apps.crm.schema). Registered from ``DealsConfig.ready()``.

``stage`` is editable in the generic paths, but a stage edit is routed through ``move_stage`` (and its
transition hook) rather than written as a field. ``pipeline`` is not edited inline.
"""

from __future__ import annotations

from apps.crm import schema as s


def _binding() -> s.Binding:
    from apps.deals import services
    from apps.deals.api import FILTERS, DealViewSet, DealWriteSerializer

    def update(actor, obj, data, *, expected_version, request=None):
        return services.update_deal(actor, obj, data, expected_version=expected_version, request=request)

    return s.Binding(
        spec=services.SPEC,
        write_serializer=DealWriteSerializer,
        filterset=FILTERS,
        queryset=lambda: DealViewSet().base_queryset(),
        create=services.create_deal,
        update=update,
    )


def module() -> s.ModuleDef:
    from apps.deals.models import Deal

    return s.ModuleDef(
        entity_type="deal",
        module="deals",
        label="Deal",
        label_plural="Deals",
        binding=_binding,
        dedupe_keys=(("name", "pipeline"),),
        default_columns=("name", "stage", "amount", "expected_close_date", "company", "owner"),
        fields=(
            s.FieldDef("name", "Name", s.TEXT, required=True, sort="name"),
            s.FieldDef(
                "pipeline",
                "Pipeline",
                s.LOOKUP,
                lookup="pipeline",
                write_key="pipeline_id",
                editable=False,
                groupable=True,
            ),
            s.FieldDef("stage", "Stage", s.STAGE, lookup="stage", write_key="stage_id", groupable=True),
            s.FieldDef("amount", "Amount", s.MONEY, sort="amount_base", currency_field="currency"),
            s.FieldDef("currency", "Currency", s.TEXT, groupable=True),
            s.FieldDef("exchange_rate", "Exchange rate", s.NUMBER),
            s.FieldDef("amount_base", "Amount (base currency)", s.MONEY, editable=False, sort="amount_base"),
            s.FieldDef("weighted_amount_base", "Weighted amount", s.MONEY, editable=False, importable=False),
            s.FieldDef("probability", "Probability", s.PERCENT, sort="probability"),
            s.FieldDef("expected_close_date", "Expected close", s.DATE, sort="expected_close_date"),
            s.FieldDef("status", "Status", s.CHOICE, choices=tuple(Deal.Status.values), editable=False, groupable=True),
            s.FieldDef("company", "Company", s.LOOKUP, lookup="company", write_key="company_id"),
            s.FieldDef(
                "primary_contact", "Primary contact", s.LOOKUP, lookup="contact", write_key="primary_contact_id"
            ),
            s.FieldDef("lost_reason", "Lost reason", s.TEXT),
            s.FieldDef("description", "Description", s.TEXTAREA),
            s.FieldDef("owner", "Owner", s.USER, write_key="owner_id", groupable=True, importable=False),
            s.FieldDef("tags", "Tags", s.TAGS, editable=False, importable=False),
            s.FieldDef("closed_at", "Closed", s.DATETIME, editable=False, importable=False),
            s.FieldDef("stage_entered_at", "In stage since", s.DATETIME, editable=False, sort="stage_entered_at"),
            s.FieldDef("last_activity_at", "Last activity", s.DATETIME, editable=False, sort="last_activity_at"),
            s.FieldDef("created_at", "Created", s.DATETIME, editable=False, sort="created_at", importable=False),
            s.FieldDef("updated_at", "Updated", s.DATETIME, editable=False, sort="updated_at", importable=False),
        ),
    )
