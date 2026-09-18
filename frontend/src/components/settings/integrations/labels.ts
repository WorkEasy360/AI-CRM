import type { ExternalValue, IntegrationAuthType, SharingDirection } from "@/lib/api/integrations";
import { humanize } from "@/lib/utils";

export const AUTH_TYPE_LABELS: Record<IntegrationAuthType, string> = {
  api_key: "API key",
  bearer_token: "Bearer token",
  oauth2_code: "OAuth 2.0 authorization code",
  oauth2_client_credentials: "OAuth 2.0 client credentials",
  signed_webhook: "Signed webhook only",
};

export const AUTH_TYPE_ORDER: IntegrationAuthType[] = ["api_key", "bearer_token", "oauth2_code", "oauth2_client_credentials", "signed_webhook"];

const SYNC_INTERVAL_LABELS: Record<number, string> = {
  0: "Manual only",
  15: "Every 15 minutes",
  60: "Hourly",
  360: "Every 6 hours",
  1440: "Daily",
};

export function syncIntervalLabel(minutes: number): string {
  return SYNC_INTERVAL_LABELS[minutes] ?? `Every ${minutes} minutes`;
}

const DIRECTION_FALLBACK: Record<SharingDirection, string> = {
  none: "Not shared",
  outbound: "CRM → External",
  inbound: "External → CRM",
  two_way: "Two-way",
};

export function directionLabel(direction: SharingDirection, labels?: { key: string; label: string }[]): string {
  return labels?.find((d) => d.key === direction)?.label ?? DIRECTION_FALLBACK[direction];
}

/** "custom.industry_code" → "Custom field: Industry code"; "first_name" → "First name". */
export function fieldLabel(field: string): string {
  if (field.startsWith("custom.")) return `Custom field: ${humanize(field.slice("custom.".length))}`;
  return humanize(field);
}

/** "deal.stage_changed" → "Deal stage changed". */
export function eventLabel(eventType: string): string {
  return humanize(eventType);
}

const ENTITY_FALLBACK: Record<string, string> = { contact: "Contact", company: "Company", deal: "Deal", task: "Task" };

export function entityLabel(entityType: string): string {
  return ENTITY_FALLBACK[entityType] ?? humanize(entityType);
}

/** CRM record page for a synced record type, when the CRM has one. */
export function recordHref(entityType: string, id: string): string | null {
  const base = { contact: "/contacts", company: "/companies", deal: "/deals" }[entityType];
  return base && id ? `${base}/${encodeURIComponent(id)}` : null;
}

const DELIVERY_ERRORS: Record<string, string> = {
  auth_expired: "The receiving system's credentials have expired.",
  auth_failed: "The receiving system rejected the credentials.",
  rate_limited: "The receiving system is limiting requests.",
  unavailable: "The receiving system was temporarily unavailable.",
  timeout: "The receiving system did not respond in time.",
  connection_failed: "Keel could not reach the receiving system.",
  dns_failure: "The address could not be found.",
  invalid_response: "The receiving system returned a response Keel could not read.",
  rejected: "The receiving system rejected the event.",
  private_destination: "The address points to a private network and is not allowed.",
  scheme_not_allowed: "Only https:// addresses are allowed.",
  port_not_allowed: "This port is not allowed.",
  invalid_url: "The address is not a valid URL.",
  redirect_not_followed: "The receiving system answered with a redirect, which Keel does not follow.",
  member_lost_access: "The member who set this up no longer has access.",
  disconnected: "The integration was disconnected before delivery.",
  permission_denied: "The integration is not allowed to send this record.",
};

/** Human text for a delivery error code; raw codes are never shown on their own. */
export function deliveryErrorMessage(code: string): string {
  if (!code) return "";
  return DELIVERY_ERRORS[code] ?? "The receiving system reported a problem.";
}

/** Readable text for a value received from an external system (no raw JSON). */
export function formatExternalValue(value: ExternalValue | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => formatExternalValue(v)).join(", ");
  return Object.entries(value)
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `${humanize(k)}: ${formatExternalValue(v)}`)
    .join("; ");
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
