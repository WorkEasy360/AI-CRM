/**
 * Features the plan catalogue (backend/apps/billing/editions.py) lists but the product does not do yet.
 * They keep their place on the Billing page with an "Upcoming" badge and no working control, so a plan
 * card or meter never reads as a promise of something that is not there.
 *
 * Audited 2026-11-07: each key below has no implementation outside the catalogue itself. Remove a key
 * here when its feature ships; nothing else needs to change.
 */

/** Plan features (edition.features keys). */
export const UPCOMING_FEATURES: ReadonlySet<string> = new Set([
  "mass_email", // no bulk sender
  "custom_dashboards", // the dashboard layout is fixed
  "accounting_integration",
  "meeting_integration",
  "social_lead_ads",
  "esign",
  "payment_links",
  "advanced_fields", // custom field types have no lookup, formula or user field
  "stage_transition_rules", // pipelines/transitions.py still allows every move
  "target_meter",
  "duplicate_cleanup", // duplicates are only flagged while creating a contact
  "data_enrichment",
  "email_in",
  "data_backup", // no backup job
]);

/** Usage meters with no counter behind them: they would always read 0. */
export const UPCOMING_METRICS: ReadonlySet<string> = new Set(["booking_pages", "mass_emails", "email_in_aliases", "file_storage"]);

/** Add-ons that raise a limit, or grant a feature, that does not exist yet. */
export const UPCOMING_ADDONS: ReadonlySet<string> = new Set(["extra_booking_pages", "extra_mass_emails", "extra_storage", "data_backup"]);
