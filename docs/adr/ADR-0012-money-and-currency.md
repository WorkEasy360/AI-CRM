# ADR-0012 — Money handling and multi-currency snapshotting

**Status:** Proposed

## Decision
- Amounts are `NUMERIC(18,2)` with an ISO 4217 `currency` code; never floats.
- Each organization has a `base_currency`. Deals and products may use any currency; deals store `exchange_rate` (to base) and `amount_base` at creation/update time. Rates come from a manually maintained per-org rate table in the MVP (an automatic provider is a later integration behind the SSRF guard).
- Reporting, dashboards, forecasting and scoring use `amount_base`; the UI shows the original amount and currency with the base equivalent.
- Formatting follows the organization's locale; the API always returns unformatted decimals as strings.

## Consequences
Historical reports do not drift when rates change; multi-currency teams work from day one; no floating-point money bugs.
