/**
 * Integration Hub API: connection catalog, generic REST connections (sharing, sync, inbound webhooks),
 * outbound webhook subscriptions and API credentials for external software.
 *
 * Secrets (webhook signing secrets, inbound secrets, API keys) are returned by exactly one response each.
 * Callers must keep them in transient component state only: never in a query cache, never logged.
 */

import { api } from "@/lib/api/client";
import type { Paginated } from "@/lib/api/types";

const enc = encodeURIComponent;
const BASE = "/api/v1/integrations";

// ----------------------------------------------------------------------------- shared

export interface MemberRef {
  id: string;
  display_name: string;
}

export interface ResultsList<T> {
  results: T[];
}

export type IntegrationProviderKey = "google" | "microsoft" | "whatsapp" | "generic_rest";
export type IntegrationCategory = "email" | "messaging" | "custom";
export type CatalogStatus = "connected" | "available" | "action_required";
export type ConnectionStatus = "connected" | "disconnected" | "action_required" | "syncing" | "error" | "disabled";
export type IntegrationAuthType = "oauth2_code" | "oauth2_client_credentials" | "api_key" | "bearer_token" | "signed_webhook";
export type SharingDirection = "none" | "outbound" | "inbound" | "two_way";
export type ConflictStrategy = "crm_wins" | "external_wins" | "newest_wins" | "manual";

// ----------------------------------------------------------------------------- connections

export interface ConnectionConventions {
  health_path?: string;
  api_key_header?: string;
  id_field?: string;
  list_key?: string;
  next_cursor_field?: string;
  cursor_param?: string;
  since_param?: string;
  update_method?: string;
  updated_field?: string;
}

export interface ConnectionOAuthConfig {
  client_id: string;
  token_url: string;
  /** Authorization-code flow only. */
  authorize_url?: string;
  revoke_url?: string;
  scopes: string[];
}

export interface ConnectionConfig {
  base_url?: string;
  oauth?: ConnectionOAuthConfig;
  conventions?: ConnectionConventions;
}

/** Write-only credential values; responses only ever list the configured names. */
export interface ConnectionCredentials {
  api_key?: string;
  token?: string;
  client_secret?: string;
}

export interface ConnectionSummary {
  id: string;
  provider: string;
  provider_name: string;
  name: string;
  status: ConnectionStatus;
  status_message: string;
  auth_type: IntegrationAuthType;
  config: ConnectionConfig;
  credentials_configured: string[];
  conflict_strategy: ConflictStrategy;
  sync_interval_minutes: number;
  next_sync_at: string | null;
  inbound_enabled: boolean;
  connected_by: MemberRef | null;
  connected_at: string | null;
  disconnected_at: string | null;
  last_sync_at: string | null;
  last_success_at: string | null;
  last_error_code: string;
  last_error_message: string;
  last_error_at: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

export interface FieldMapping {
  crm_field: string;
  external_field: string;
}

export interface SharingPolicy {
  entity_type: string;
  direction: SharingDirection;
  external_resource: string;
  mappings: FieldMapping[];
}

export type SyncJobStatus = "pending" | "processing" | "completed" | "failed";

export interface SyncJobError {
  entity_type: string;
  record_id: string;
  code: string;
  message: string;
}

export interface SyncJob {
  id: string;
  trigger: "manual" | "scheduled";
  status: SyncJobStatus;
  processed: number;
  succeeded: number;
  failed: number;
  conflicts: number;
  errors: SyncJobError[];
  error_code: string;
  error_message: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface ConnectionDetail extends ConnectionSummary {
  sharing: SharingPolicy[];
  latest_job: SyncJob | null;
  open_conflicts: number;
  failed_deliveries: number;
}

export type DeliveryStatus = "pending" | "succeeded" | "skipped" | "failed" | "dead";

export interface Delivery {
  id: string;
  event_id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  status: DeliveryStatus;
  attempts: number;
  next_attempt_at: string | null;
  response_status: number | null;
  error_code: string;
  delivered_at: string | null;
  created_at: string;
}

export type ExternalValue = string | number | boolean | null | ExternalValue[] | { [key: string]: ExternalValue };

export interface SyncConflict {
  id: string;
  entity_type: string;
  crm_record_id: string;
  external_record_id: string;
  fields: string[];
  external_values: Record<string, ExternalValue>;
  status: string;
  resolved_at: string | null;
  created_at: string;
}

export type ConflictResolution = "keep_crm" | "apply_external";

export interface ConnectionTestResult {
  ok: boolean;
  code: string;
  message: string;
}

/** Shown once: the URL key and secret cannot be read back. */
export interface InboundWebhookReveal {
  url: string;
  secret: string;
}

export interface RotatedSecret {
  secret: string;
}

export interface ConnectionCreateInput {
  provider: "generic_rest";
  name: string;
  auth_type: IntegrationAuthType;
  config: ConnectionConfig;
  credentials: ConnectionCredentials;
}

export interface ConnectionUpdateInput {
  name?: string;
  config?: ConnectionConfig;
  conflict_strategy?: ConflictStrategy;
  sync_interval_minutes?: number;
}

// ----------------------------------------------------------------------------- catalog and options

export interface MailboxSummary {
  status: string;
  email_address: string;
}

export interface CatalogItem {
  key: IntegrationProviderKey;
  name: string;
  description: string;
  category: IntegrationCategory;
  auth_types: IntegrationAuthType[];
  /** Integrations managed on their own settings page. */
  manage_url: string | null;
  supports_sync: boolean;
  supports_inbound_webhooks: boolean;
  status: CatalogStatus;
  connected_count: number;
  configured?: boolean;
  error_count?: number;
  mine?: MailboxSummary | null;
  connections?: ConnectionSummary[];
}

export interface IntegrationCatalog {
  results: CatalogItem[];
  can_manage: boolean;
  can_manage_webhooks: boolean;
}

export interface OptionEntity {
  key: string;
  label: string;
  shareable: boolean;
  reason: string;
  outbound_fields?: string[];
  inbound_fields?: string[];
  inbound_create?: boolean;
}

export interface KeyLabel<K extends string = string> {
  key: K;
  label: string;
}

export interface IntegrationOptions {
  entities: OptionEntity[];
  directions: KeyLabel<SharingDirection>[];
  conflict_strategies: KeyLabel<ConflictStrategy>[];
  sync_intervals: number[];
  webhook_event_types: string[];
  api_scopes: KeyLabel[];
  api_key_max_days: number;
  oauth_redirect_uri: string;
}

// ----------------------------------------------------------------------------- outbound webhooks

export type WebhookStatus = "active" | "paused" | "disabled";

export interface WebhookSubscription {
  id: string;
  name: string;
  url: string;
  event_types: string[];
  include_data: boolean;
  status: WebhookStatus;
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error_code: string;
  rotation_in_progress: boolean;
  created_by: MemberRef | null;
  created_at: string;
  updated_at: string;
}

export type WebhookSubscriptionWithSecret = WebhookSubscription & { secret: string };

export interface WebhookCreateInput {
  name: string;
  url: string;
  event_types: string[];
  include_data: boolean;
}

export type WebhookUpdateInput = Partial<WebhookCreateInput>;

export interface WebhookTestResult {
  ok: boolean;
  response_status: number | null;
  error_code: string;
  message: string;
}

// ----------------------------------------------------------------------------- API credentials

export type ApiCredentialStatus = "active" | "expired" | "revoked";

export interface ApiCredential {
  id: string;
  name: string;
  display_key: string;
  scopes: string[];
  status: ApiCredentialStatus;
  created_by: MemberRef | null;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export type ApiCredentialWithKey = ApiCredential & { key: string };

export interface ApiCredentialCreateInput {
  name: string;
  scopes: string[];
  /** `null` creates a key that never expires. */
  expires_in_days: number | null;
}

// ----------------------------------------------------------------------------- query keys

/** React Query keys. Revealed secrets are never stored under any of these. */
export const integrationKeys = {
  all: ["integrations"] as const,
  catalog: ["integrations", "catalog"] as const,
  options: ["integrations", "options"] as const,
  connections: ["integrations", "connections"] as const,
  connection: (id: string) => ["integrations", "connections", id] as const,
  jobs: (id: string) => ["integrations", "connections", id, "jobs"] as const,
  deliveries: (id: string) => ["integrations", "connections", id, "deliveries"] as const,
  conflicts: (id: string) => ["integrations", "connections", id, "conflicts"] as const,
  webhooks: ["integrations", "webhooks"] as const,
  webhookDeliveries: (id: string) => ["integrations", "webhook-deliveries", id] as const,
  apiCredentials: ["integrations", "api-credentials"] as const,
};

// ----------------------------------------------------------------------------- endpoints

export const getIntegrationCatalog = () => api.get<IntegrationCatalog>(`${BASE}/catalog/`);
export const getIntegrationOptions = () => api.get<IntegrationOptions>(`${BASE}/options/`);

export const listConnections = (cursor: string | null) => api.get<Paginated<ConnectionSummary>>(`${BASE}/connections/`, { cursor });
export const getConnection = (id: string) => api.get<ConnectionDetail>(`${BASE}/connections/${enc(id)}/`);
/** Sensitive: wrap in `runSensitive`. */
export const createConnection = (input: ConnectionCreateInput) => api.post<ConnectionDetail>(`${BASE}/connections/`, input);
/** Changing `config` is sensitive: wrap in `runSensitive`. */
export const updateConnection = (id: string, input: ConnectionUpdateInput) => api.patch<ConnectionDetail>(`${BASE}/connections/${enc(id)}/`, input);
/** Sensitive; only allowed once the connection is disconnected. */
export const deleteConnection = (id: string) => api.delete(`${BASE}/connections/${enc(id)}/`);
export const testConnection = (id: string) => api.post<ConnectionTestResult>(`${BASE}/connections/${enc(id)}/test/`);
export const syncConnection = (id: string) => api.post<SyncJob>(`${BASE}/connections/${enc(id)}/sync/`);
export const pauseConnection = (id: string) => api.post<ConnectionDetail>(`${BASE}/connections/${enc(id)}/pause/`);
export const resumeConnection = (id: string) => api.post<ConnectionDetail>(`${BASE}/connections/${enc(id)}/resume/`);
/** Sensitive: revokes tokens and wipes stored secrets. CRM data is kept. */
export const disconnectConnection = (id: string) => api.post<ConnectionDetail>(`${BASE}/connections/${enc(id)}/disconnect/`);
/** Sensitive. */
export const updateConnectionCredentials = (id: string, credentials: ConnectionCredentials) =>
  api.post<ConnectionDetail>(`${BASE}/connections/${enc(id)}/credentials/`, { credentials });
/** Sensitive. The caller navigates to `authorization_url` after checking it is https. */
export const startConnectionOAuth = (id: string) => api.post<{ authorization_url: string }>(`${BASE}/connections/${enc(id)}/oauth/start/`);
/** Sensitive when sharing is widened. */
export const updateConnectionSharing = (id: string, policy: SharingPolicy) => api.put<ConnectionDetail>(`${BASE}/connections/${enc(id)}/sharing/`, policy);
/** Sensitive. The URL and secret are shown once. */
export const enableInboundWebhook = (id: string) => api.post<InboundWebhookReveal>(`${BASE}/connections/${enc(id)}/inbound/`);
/** Sensitive. The secret is shown once; the previous secret keeps working for 24 hours. */
export const rotateInboundSecret = (id: string) => api.post<RotatedSecret>(`${BASE}/connections/${enc(id)}/inbound/rotate-secret/`);
export const listConnectionJobs = (id: string) => api.get<ResultsList<SyncJob>>(`${BASE}/connections/${enc(id)}/jobs/`);
export const listConnectionDeliveries = (id: string) => api.get<ResultsList<Delivery>>(`${BASE}/connections/${enc(id)}/deliveries/`);
export const listConnectionConflicts = (id: string) => api.get<ResultsList<SyncConflict>>(`${BASE}/connections/${enc(id)}/conflicts/`);
export const resolveConflict = (id: string, conflictId: string, resolution: ConflictResolution) =>
  api.post<SyncConflict>(`${BASE}/connections/${enc(id)}/conflicts/${enc(conflictId)}/resolve/`, { resolution });

export const listWebhooks = (cursor: string | null) => api.get<Paginated<WebhookSubscription>>(`${BASE}/webhooks/`, { cursor });
/** Sensitive. The signing secret is shown once. */
export const createWebhook = (input: WebhookCreateInput) => api.post<WebhookSubscriptionWithSecret>(`${BASE}/webhooks/`, input);
export const updateWebhook = (id: string, input: WebhookUpdateInput) => api.patch<WebhookSubscription>(`${BASE}/webhooks/${enc(id)}/`, input);
/** Sensitive. */
export const deleteWebhook = (id: string) => api.delete(`${BASE}/webhooks/${enc(id)}/`);
/** Sensitive. The new signing secret is shown once. */
export const rotateWebhookSecret = (id: string) => api.post<WebhookSubscriptionWithSecret>(`${BASE}/webhooks/${enc(id)}/rotate-secret/`);
export const pauseWebhook = (id: string) => api.post<WebhookSubscription>(`${BASE}/webhooks/${enc(id)}/pause/`);
export const resumeWebhook = (id: string) => api.post<WebhookSubscription>(`${BASE}/webhooks/${enc(id)}/resume/`);
export const testWebhook = (id: string) => api.post<WebhookTestResult>(`${BASE}/webhooks/${enc(id)}/test/`);
export const listWebhookDeliveries = (id: string) => api.get<ResultsList<Delivery>>(`${BASE}/webhooks/${enc(id)}/deliveries/`);

export const listApiCredentials = (cursor: string | null) => api.get<Paginated<ApiCredential>>(`${BASE}/api-credentials/`, { cursor });
/** Sensitive. The full key is shown once. */
export const createApiCredential = (input: ApiCredentialCreateInput) => api.post<ApiCredentialWithKey>(`${BASE}/api-credentials/`, input);
export const revokeApiCredential = (id: string) => api.delete(`${BASE}/api-credentials/${enc(id)}/`);
