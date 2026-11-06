import { api } from "@/lib/api/client";

export type EditionKey = "free" | "express" | "premier" | "edition_360";
export type BillingCycle = "monthly" | "annual";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled";
export type UsageState = "ok" | "warning" | "at_limit" | "unlimited" | "not_included";

export interface EditionRef {
  key: EditionKey;
  name: string;
}

export interface Edition extends EditionRef {
  rank: number;
  tagline: string;
  price_monthly_cents: number;
  price_annual_cents: number;
  limits: Record<string, number | null>;
  features: string[];
}

export interface Addon {
  key: string;
  label: string;
  metric: string | null;
  feature: string | null;
  unit_amount: number;
  price_cents: number;
  recurring: boolean;
}

export interface EditionCatalog {
  editions: Edition[];
  features: { key: string; label: string }[];
  metrics: { key: string; label: string; period: string; unit: string }[];
  addons: Addon[];
}

export interface Subscription {
  edition: EditionRef;
  subscribed_edition: EditionKey;
  status: SubscriptionStatus;
  billing_cycle: BillingCycle;
  seats: number;
  seat_limit: number | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  grandfathered: boolean;
  features: string[];
  self_service: boolean;
}

export interface UsageMetric {
  key: string;
  label: string;
  period: "count" | "monthly" | "daily";
  unit: "count" | "bytes" | "credits" | "emails";
  used: number;
  limit: number | null;
  addon_amount: number;
  modules: { module: string; used: number }[] | null;
  state: UsageState;
  upgrade_edition: EditionRef | null;
  addon: string | null;
}

export interface UsageReport {
  edition: EditionRef;
  features: string[];
  metrics: UsageMetric[];
  /** What counts towards the record limit (shown under the records meter). */
  record_definition?: string;
}

export interface AddonPurchase {
  id: string;
  addon: string;
  quantity: number;
  status: "active" | "cancelled";
  period_key: string;
  created_at: string;
  cancelled_at: string | null;
}

export const billingKeys = {
  catalog: ["billing", "catalog"] as const,
  subscription: ["billing", "subscription"] as const,
  usage: ["billing", "usage"] as const,
  addons: ["billing", "addons"] as const,
};

export const getEditionCatalog = () => api.get<EditionCatalog>("/api/v1/billing/editions/");
export const getSubscription = () => api.get<Subscription>("/api/v1/billing/subscription/");
export const getUsage = () => api.get<UsageReport>("/api/v1/billing/usage/");
export const listAddonPurchases = () => api.get<{ results: AddonPurchase[] }>("/api/v1/billing/addons/");
export const changePlan = (input: { edition: EditionKey; billing_cycle?: BillingCycle; seats?: number }) =>
  api.post<Subscription>("/api/v1/billing/subscription/", input);
export const purchaseAddon = (addon: string, quantity = 1) =>
  api.post<AddonPurchase>("/api/v1/billing/addons/", { addon, quantity });
export const cancelAddon = (id: string) =>
  api.post<AddonPurchase>(`/api/v1/billing/addons/${encodeURIComponent(id)}/cancel/`);
