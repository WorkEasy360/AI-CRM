"""Company fields as data (apps.crm.schema). Registered from ``CompaniesConfig.ready()``."""

from __future__ import annotations

from apps.crm import schema as s


def _binding() -> s.Binding:
    from apps.companies.api import FILTERS, SPEC, CompanyViewSet, CompanyWriteSerializer, create_company, update_company

    return s.Binding(
        spec=SPEC,
        write_serializer=CompanyWriteSerializer,
        filterset=FILTERS,
        queryset=lambda: CompanyViewSet().base_queryset(),
        create=create_company,
        update=update_company,
    )


def module() -> s.ModuleDef:
    from apps.companies.models import COMPANY_SIZES
    from apps.lifecycle.stages import LIFECYCLE_STAGES

    return s.ModuleDef(
        entity_type="company",
        module="companies",
        label="Company",
        label_plural="Companies",
        binding=_binding,
        dedupe_keys=(("website",), ("name",)),
        default_columns=("name", "website", "industry", "lifecycle_stage", "owner"),
        fields=(
            s.FieldDef("name", "Name", s.TEXT, required=True, sort="name"),
            s.FieldDef("website", "Website", s.URL),
            s.FieldDef("phone", "Phone", s.PHONE),
            s.FieldDef("industry", "Industry", s.TEXT, groupable=True),
            s.FieldDef("company_size", "Company size", s.CHOICE, choices=tuple(COMPANY_SIZES), groupable=True),
            s.FieldDef(
                "annual_revenue", "Annual revenue", s.MONEY, sort="annual_revenue", currency_field="revenue_currency"
            ),
            s.FieldDef("revenue_currency", "Revenue currency", s.TEXT),
            s.FieldDef("source", "Source", s.TEXT, groupable=True),
            s.FieldDef(
                "lifecycle_stage",
                "Lifecycle stage",
                s.CHOICE,
                choices=tuple(LIFECYCLE_STAGES),
                sort="lifecycle_stage",
                groupable=True,
            ),
            s.FieldDef("description", "Description", s.TEXTAREA),
            s.FieldDef("owner", "Owner", s.USER, write_key="owner_id", groupable=True, importable=False),
            s.FieldDef("tags", "Tags", s.TAGS, editable=False, importable=False),
            s.FieldDef("last_activity_at", "Last activity", s.DATETIME, editable=False, sort="last_activity_at"),
            s.FieldDef("created_at", "Created", s.DATETIME, editable=False, sort="created_at", importable=False),
            s.FieldDef("updated_at", "Updated", s.DATETIME, editable=False, sort="updated_at", importable=False),
        ),
    )
