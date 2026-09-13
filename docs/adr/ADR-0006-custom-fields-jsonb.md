# ADR-0006 — Custom fields stored as validated JSONB with a definitions table

**Status:** Accepted (2026-09-12); implemented in Phase 2 (`apps/customfields`)

## Context
Tenants need custom fields of 13 types on contacts, companies, deals and products, usable in grids, filters, sorts, imports/exports and AI context. Options: entity-attribute-value tables (`custom_field_value` rows), a JSONB column per record, or dynamic columns.

## Decision
A `custom_field_definition` table per organization and entity type (key, label, type, options, required, indexed) and a `custom_data JSONB` column on each supported entity. All reads and writes go through the `customfields` service, which validates values against the definitions (type coercion, options, required, length caps, email/phone/URL formats), rejects unknown keys and keys that collide with built-in fields, and produces typed filter/sort expressions from an allowlist. Expression indexes are created for definitions flagged `is_indexed` (capped per entity).

## Consequences
- One row per record; no N+1 for custom values; grids and exports are simple.
- Filtering by custom field is efficient when indexed and acceptable otherwise.
- Validation and authorization live in one service, so custom fields cannot bypass them; serializers never accept raw JSON for `custom_data` outside that path.
- Changing a field's type after data exists requires an explicit, audited migration action (archive + new field, or a validated conversion job).
