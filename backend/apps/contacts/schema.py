"""Contact fields as data (apps.crm.schema). Registered from ``ContactsConfig.ready()``."""

from __future__ import annotations

from apps.crm import schema as s


def _binding() -> s.Binding:
    from apps.contacts.api import FILTERS, SPEC, ContactViewSet, ContactWriteSerializer, create_contact, update_contact

    return s.Binding(
        spec=SPEC,
        write_serializer=ContactWriteSerializer,
        filterset=FILTERS,
        queryset=lambda: ContactViewSet().base_queryset(),
        create=create_contact,
        update=update_contact,
    )


def module() -> s.ModuleDef:
    from apps.lifecycle.stages import LIFECYCLE_STAGES

    return s.ModuleDef(
        entity_type="contact",
        module="contacts",
        label="Contact",
        label_plural="Contacts",
        title_field="display_name",
        binding=_binding,
        dedupe_keys=(("email",), ("phone",)),
        default_columns=("display_name", "email", "phone", "company", "lifecycle_stage", "owner"),
        fields=(
            s.FieldDef(
                "display_name", "Name", s.TEXT, editable=False, sort="last_name", importable=False, exportable=False
            ),
            s.FieldDef("first_name", "First name", s.TEXT, sort="first_name"),
            s.FieldDef("last_name", "Last name", s.TEXT, sort="last_name"),
            s.FieldDef("email", "Email", s.EMAIL, sort="email"),
            s.FieldDef("phone", "Phone", s.PHONE),
            s.FieldDef("job_title", "Job title", s.TEXT, sort="job_title"),
            s.FieldDef("company", "Company", s.LOOKUP, lookup="company", sort="company_name", write_key="company_id"),
            s.FieldDef("source", "Source", s.TEXT, groupable=True),
            s.FieldDef(
                "lifecycle_stage",
                "Lifecycle stage",
                s.CHOICE,
                choices=tuple(LIFECYCLE_STAGES),
                sort="lifecycle_stage",
                groupable=True,
            ),
            s.FieldDef("whatsapp_opt_in", "WhatsApp opt-in", s.BOOLEAN, groupable=True, importable=False),
            s.FieldDef("description", "Description", s.TEXTAREA),
            s.FieldDef("owner", "Owner", s.USER, write_key="owner_id", groupable=True, importable=False),
            s.FieldDef("tags", "Tags", s.TAGS, editable=False, importable=False),
            s.FieldDef("last_activity_at", "Last activity", s.DATETIME, editable=False, sort="last_activity_at"),
            s.FieldDef("next_activity_at", "Next activity", s.DATETIME, editable=False, sort="next_activity_at"),
            s.FieldDef("created_at", "Created", s.DATETIME, editable=False, sort="created_at", importable=False),
            s.FieldDef("updated_at", "Updated", s.DATETIME, editable=False, sort="updated_at", importable=False),
        ),
    )
