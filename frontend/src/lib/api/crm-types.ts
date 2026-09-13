/**
 * Hand-written types for the CRM API (contacts, companies, products, pipelines, deals, custom fields,
 * tags, notes, timeline, search, import/export, activities, notifications, email, WhatsApp, forecast,
 * AI). They mirror the backend serializers one-to-one; the generated `schema.d.ts` stays the source
 * for the Phase 1 surface.
 */

export interface MembershipRef {
  id: string;
  display_name: string;
}

export interface NamedRef {
  id: string;
  name: string;
}

export interface TagRef {
  id: string;
  name: string;
  color_token: string;
}

export interface Tag extends TagRef {
  usage_count: number;
  created_at: string;
}

export const TAG_COLORS = ["slate", "blue", "teal", "green", "amber", "red", "purple", "pink"] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export type CustomValue = string | number | boolean | string[] | null;
export type CustomData = Record<string, CustomValue>;

export const ENTITY_TYPES = ["contact", "company", "deal", "product"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** Entity types that carry notes, activities, emails and a timeline (products do not). */
export type RelatedEntityType = "contact" | "company" | "deal";

export const CUSTOM_FIELD_TYPES = [
  "text",
  "textarea",
  "integer",
  "number",
  "currency",
  "percent",
  "date",
  "datetime",
  "checkbox",
  "dropdown",
  "multi_select",
  "email",
  "phone",
  "url",
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export interface CustomFieldDefinition {
  id: string;
  entity_type: EntityType;
  key: string;
  label: string;
  description: string;
  field_type: CustomFieldType;
  options: string[];
  is_required: boolean;
  position: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomFieldCreateInput {
  entity_type: EntityType;
  key: string;
  label: string;
  description?: string;
  field_type: CustomFieldType;
  options?: string[];
  is_required?: boolean;
}

export interface CustomFieldUpdateInput {
  label?: string;
  description?: string;
  options?: string[];
  is_required?: boolean;
  position?: number;
}

export interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
}

/* ------------------------------------------------------------------ lifecycle */

export const LIFECYCLE_STAGES = ["lead", "prospect", "qualified", "customer", "inactive"] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];
export const LIFECYCLE_LABELS: Record<LifecycleStage, string> = {
  lead: "Lead",
  prospect: "Prospect",
  qualified: "Qualified",
  customer: "Customer",
  inactive: "Inactive",
};

/** Fields every CRM record carries. */
export interface CrmRecord {
  id: string;
  owner: MembershipRef | null;
  tags: TagRef[];
  custom_data: CustomData;
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Contact extends CrmRecord {
  first_name: string;
  last_name: string;
  display_name: string;
  email: string;
  phone: string;
  job_title: string;
  company: NamedRef | null;
  source: string;
  address: Address;
  description: string;
  open_deal_count: number;
  last_activity_at: string | null;
  next_activity_at: string | null;
  next_activity_title: string;
  lifecycle_stage: LifecycleStage;
  lifecycle_changed_at: string | null;
  whatsapp_opt_in: boolean;
  whatsapp_opt_in_at: string | null;
  /** Rules-based lead score 0-100 computed on the server. */
  lead_score: number;
}

export interface ContactInput {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  job_title?: string;
  company_id?: string | null;
  source?: string;
  address?: Address;
  description?: string;
  owner_id?: string | null;
  custom_data?: CustomData;
  lifecycle_stage?: LifecycleStage;
  whatsapp_opt_in?: boolean;
}

export interface ContactDuplicate {
  id: string;
  display_name: string;
  email: string;
  phone: string;
  company: NamedRef | null;
  matched_on: ("email" | "phone" | "name")[];
}

export interface CompanyDuplicate {
  id: string;
  name: string;
  website: string;
  industry: string;
  matched_on: ("name" | "website")[];
}

export const COMPANY_SIZES = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5000+"] as const;

export interface Company extends CrmRecord {
  name: string;
  website: string;
  phone: string;
  industry: string;
  company_size: string;
  annual_revenue: string | null;
  revenue_currency: string;
  address: Address;
  source: string;
  description: string;
  contact_count: number;
  open_deal_count: number;
  open_deal_amount: string;
  won_deal_amount: string;
  last_activity_at: string | null;
  next_activity_at: string | null;
  next_activity_title: string;
  lifecycle_stage: LifecycleStage;
  lifecycle_changed_at: string | null;
}

export interface CompanyInput {
  name?: string;
  website?: string;
  phone?: string;
  industry?: string;
  company_size?: string;
  annual_revenue?: string | null;
  revenue_currency?: string;
  address?: Address;
  source?: string;
  description?: string;
  owner_id?: string | null;
  custom_data?: CustomData;
  lifecycle_stage?: LifecycleStage;
}

export interface Product extends CrmRecord {
  name: string;
  sku: string;
  description: string;
  unit_price: string;
  currency: string;
  tax_rate: string;
  tax_label: string;
  status: "active" | "inactive";
}

export interface ProductInput {
  name?: string;
  sku?: string;
  description?: string;
  unit_price?: string;
  currency?: string;
  tax_rate?: string;
  tax_label?: string;
  status?: "active" | "inactive";
  owner_id?: string | null;
  custom_data?: CustomData;
}

export type StageKind = "open" | "won" | "lost";

export interface PipelineStage {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
  kind: StageKind;
  default_probability: number;
  description: string;
  color_token: string;
  archived_at: string | null;
}

export interface Pipeline {
  id: string;
  name: string;
  position: number;
  is_default: boolean;
  stages: PipelineStage[];
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StageInput {
  name?: string;
  kind?: StageKind;
  default_probability?: number;
  description?: string;
  color_token?: string;
}

export interface StageRef {
  id: string;
  name: string;
  kind: StageKind;
  color_token: string;
}

export interface ContactRef {
  id: string;
  name: string;
  email: string;
  /** Present (string) only when the member may view the contact record; null otherwise. */
  phone?: string | null;
  whatsapp_opt_in?: boolean | null;
}

export type DealStatus = "open" | "won" | "lost";
export type RiskLevel = "low" | "medium" | "high";

export interface Deal extends CrmRecord {
  name: string;
  pipeline: NamedRef;
  stage: StageRef;
  company: NamedRef | null;
  primary_contact: ContactRef | null;
  amount: string;
  currency: string;
  exchange_rate: string;
  amount_base: string;
  probability: number;
  probability_overridden: boolean;
  /** amount_base x probability, computed on the server. */
  weighted_amount_base: string;
  expected_close_date: string | null;
  status: DealStatus;
  closed_at: string | null;
  lost_reason: string;
  stage_entered_at: string;
  last_activity_at: string | null;
  next_activity_at: string | null;
  next_activity_title: string;
  risk_level: RiskLevel;
  description: string;
  line_count: number;
  contact_count: number;
  products_total: string | null;
}

export interface DealInput {
  name?: string;
  pipeline_id?: string;
  stage_id?: string;
  company_id?: string | null;
  primary_contact_id?: string | null;
  amount?: string;
  currency?: string;
  exchange_rate?: string | null;
  probability?: number;
  expected_close_date?: string | null;
  lost_reason?: string;
  description?: string;
  owner_id?: string | null;
  custom_data?: CustomData;
}

export interface DealLine {
  id: string;
  product: NamedRef;
  sku: string;
  quantity: string;
  unit_price: string;
  currency: string;
  discount_percent: string;
  tax_rate: string;
  line_total: string;
  created_at: string;
}

export interface DealLineInput {
  product_id?: string;
  quantity?: string;
  unit_price?: string;
  discount_percent?: string;
  tax_rate?: string;
}

export interface DealContactLink {
  id: string;
  contact: ContactRef;
  role_label: string;
  created_at: string;
}

export interface StageHistoryEntry {
  id: string;
  from_stage: StageRef | null;
  to_stage: StageRef;
  changed_by: MembershipRef | null;
  changed_at: string;
  duration_seconds: number | null;
  source: string;
}

export interface BoardStage extends PipelineStage {
  deal_count: number;
  total_amount_base: string;
  deals: Deal[];
  has_more: boolean;
}

export interface Board {
  pipeline: NamedRef | null;
  stages: BoardStage[];
}

/* ------------------------------------------------------------------ deal insights (rules-based, no LLM) */

export interface DealInsights {
  computed_at: string;
  risk: {
    level: RiskLevel;
    score: number;
    label: string;
    reasons: string[];
    recommended_action: string;
    signals: { signal: string; weight: number; days?: number }[];
  };
  next_best_action: {
    action: string;
    reason: string;
    evidence: string[];
    kind: string;
    confidence: "high" | "medium" | "low";
  } | null;
  lead_score: { value: number; label: string; reasons: string[] } | null;
  communication: { last_outbound_at: string | null; last_inbound_at: string | null };
}

export interface LeadScore {
  value: number;
  label: string;
  reasons: string[];
  factors: { key: string; points: number; reason: string }[];
}

/* ------------------------------------------------------------------ notes / timeline */

export interface Note {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  body: string;
  author: MembershipRef | null;
  pinned: boolean;
  edited_at: string | null;
  created_at: string;
  updated_at: string;
}

export type TimelineKind =
  | "record.created"
  | "record.updated"
  | "record.archived"
  | "record.restored"
  | "note"
  | "deal.stage_changed"
  | "deal.linked"
  | "lifecycle.changed"
  | "activity.task"
  | "activity.call"
  | "activity.meeting"
  | "email"
  | "whatsapp";

export interface TimelineEvent {
  id: string;
  kind: TimelineKind | string;
  occurred_at: string;
  actor: MembershipRef | null;
  data: Record<string, unknown>;
}

/** Families accepted by `?kinds=` on the timeline endpoint. */
export const TIMELINE_FILTERS = [
  { value: "note", label: "Notes" },
  { value: "activity", label: "Activities" },
  { value: "email", label: "Emails" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "deal", label: "Deals" },
  { value: "lifecycle", label: "Status" },
  { value: "record", label: "Changes" },
] as const;

/* ------------------------------------------------------------------ search */

export type SearchEntityType = EntityType | "activity";

export interface SearchHit {
  id: string;
  type: SearchEntityType;
  title: string;
  subtitle: string;
  meta: string;
}

export interface SearchResponse {
  query: string;
  results: Partial<Record<SearchEntityType, SearchHit[]>>;
}

/* ------------------------------------------------------------------ import / export */

export type JobStatus = "uploaded" | "pending" | "running" | "completed" | "failed";

export interface ImportRowError {
  row: number;
  errors: { field: string; message: string }[];
}

export interface ImportJob {
  id: string;
  entity_type: EntityType;
  status: JobStatus;
  original_filename: string;
  size_bytes: number;
  headers: string[];
  mapping: Record<string, string>;
  options: Record<string, unknown>;
  total_rows: number;
  processed_rows: number;
  created_rows: number;
  error_rows: number;
  errors: ImportRowError[];
  error_message: string;
  requested_by: MembershipRef | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  /** Present on the upload response and the preview endpoint. */
  preview?: Record<string, string>[];
  targets?: Record<string, string>;
}

export interface ExportJob {
  id: string;
  entity_type: EntityType;
  status: JobStatus;
  filters: Record<string, string>;
  row_count: number;
  size_bytes: number;
  error_message: string;
  requested_by: MembershipRef | null;
  started_at: string | null;
  finished_at: string | null;
  expires_at: string | null;
  download_count: number;
  created_at: string;
}

export interface BulkResult {
  action: string;
  requested: number;
  affected: number;
}

export interface ContactStats {
  total: number;
  with_open_deals: number;
  without_deals: number;
  untouched: number;
}

export interface CompanyStats {
  total: number;
  with_open_deals: number;
  with_won_deals: number;
  without_deals: number;
}

/* ------------------------------------------------------------------ activities */

export const ACTIVITY_KINDS = ["task", "call", "meeting"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const ACTIVITY_STATUSES = ["open", "in_progress", "completed", "cancelled"] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];
export const ACTIVITY_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type ActivityPriority = (typeof ACTIVITY_PRIORITIES)[number];
export type CallDirection = "inbound" | "outbound";
export const CALL_OUTCOMES = [
  "connected",
  "no_answer",
  "voicemail",
  "busy",
  "interested",
  "not_interested",
  "follow_up_required",
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
export const CALL_OUTCOME_LABELS: Record<CallOutcome, string> = {
  connected: "Connected",
  no_answer: "No answer",
  voicemail: "Voicemail",
  busy: "Busy",
  interested: "Interested",
  not_interested: "Not interested",
  follow_up_required: "Follow-up required",
};

export interface ActivityContactRef {
  id: string;
  name: string;
}

export interface Activity {
  id: string;
  kind: ActivityKind;
  title: string;
  description: string;
  status: ActivityStatus;
  priority: ActivityPriority;
  start_at: string | null;
  end_at: string | null;
  all_day: boolean;
  duration_minutes: number | null;
  timezone: string;
  location: string;
  meeting_url: string;
  direction: CallDirection | "";
  outcome: CallOutcome | "";
  reminder_minutes: number | null;
  completed_at: string | null;
  owner: MembershipRef | null;
  contact: ActivityContactRef | null;
  company: NamedRef | null;
  deal: NamedRef | null;
  attendees: MembershipRef[];
  is_overdue: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ActivityInput {
  kind?: ActivityKind;
  title?: string;
  description?: string;
  status?: ActivityStatus;
  priority?: ActivityPriority;
  start_at?: string | null;
  end_at?: string | null;
  all_day?: boolean;
  duration_minutes?: number | null;
  timezone?: string;
  location?: string;
  meeting_url?: string;
  direction?: CallDirection | "";
  outcome?: CallOutcome | "";
  reminder_minutes?: number | null;
  contact_id?: string | null;
  company_id?: string | null;
  deal_id?: string | null;
  owner_id?: string | null;
  attendee_ids?: string[];
  /** Create the activity already completed (log a call, tick a task). */
  completed?: boolean;
}

export interface ActivitySummary {
  overdue: number;
  due_today: number;
  open_tasks: number;
  meetings_week: number;
  calls_week: number;
}

/* ------------------------------------------------------------------ notifications */

export const NOTIFICATION_KINDS = [
  "task_due",
  "meeting_soon",
  "call_soon",
  "deal_assigned",
  "deal_inactive",
  "customer_replied",
  "ai_high_risk",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const NOTIFICATION_LABELS: Record<NotificationKind, string> = {
  task_due: "Task due",
  meeting_soon: "Meeting approaching",
  call_soon: "Call scheduled",
  deal_assigned: "Deal assigned to me",
  deal_inactive: "Deal inactivity warning",
  customer_replied: "Customer replied",
  ai_high_risk: "Deal at high risk",
};

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  entity_type: "deal" | "contact" | "company" | "activity" | "";
  entity_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface NotificationPreferences {
  kinds: NotificationKind[];
  in_app: Record<NotificationKind, boolean>;
  email: Record<NotificationKind, boolean>;
  deal_inactive_days: number;
}

/* ------------------------------------------------------------------ email */

export type EmailProvider = "gmail" | "microsoft";
export type ConnectionStatus = "connected" | "error" | "disconnected";

export interface EmailAccount {
  id: string;
  provider: EmailProvider;
  email_address: string;
  display_name: string;
  status: ConnectionStatus;
  error_message: string;
  last_sync_at: string | null;
  connected_at: string | null;
  membership: MembershipRef;
}

export interface EmailProviderOption {
  key: EmailProvider;
  label: string;
  configured: boolean;
}

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  is_shared: boolean;
  created_by: MembershipRef | null;
  created_at: string;
  updated_at: string;
}

export interface EmailTemplateInput {
  name?: string;
  subject?: string;
  body?: string;
  is_shared?: boolean;
}

export type MessageDirection = "outbound" | "inbound";
export type EmailStatus = "queued" | "sent" | "failed" | "received";

export interface EmailAttachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

export interface EmailMessage {
  id: string;
  direction: MessageDirection;
  status: EmailStatus;
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  subject: string;
  body_text: string;
  snippet: string;
  provider_thread_id: string;
  contact: ActivityContactRef | null;
  company: NamedRef | null;
  deal: NamedRef | null;
  sent_by: MembershipRef | null;
  sent_at: string | null;
  received_at: string | null;
  error_message: string;
  ai_assisted: boolean;
  attachments: EmailAttachment[];
  created_at: string;
}

export interface EmailSendInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
  contact_id?: string | null;
  company_id?: string | null;
  deal_id?: string | null;
  template_id?: string | null;
  in_reply_to_id?: string | null;
  ai_assisted?: boolean;
}

/* ------------------------------------------------------------------ whatsapp */

export interface WhatsAppAccountStatus {
  connected: boolean;
  phone_number_id?: string;
  display_phone?: string;
  display_name?: string;
  connected_at?: string | null;
  webhook_configured: boolean;
}

export interface WhatsAppTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  body: string;
  parameter_count: number;
  status: string;
  created_at: string;
}

export type WhatsAppStatus = "queued" | "sent" | "delivered" | "read" | "failed" | "received";

export interface WhatsAppMessage {
  id: string;
  direction: MessageDirection;
  status: WhatsAppStatus;
  wa_id: string;
  message_type: "text" | "template";
  body: string;
  template: WhatsAppTemplate | null;
  template_params: string[];
  contact: ActivityContactRef | null;
  deal: NamedRef | null;
  sent_by: MembershipRef | null;
  sent_at: string | null;
  received_at: string | null;
  error_message: string;
  ai_assisted: boolean;
  created_at: string;
}

export interface WhatsAppSendInput {
  contact_id: string;
  deal_id?: string | null;
  company_id?: string | null;
  message_type?: "text" | "template";
  body?: string;
  template_id?: string | null;
  template_params?: string[];
  ai_assisted?: boolean;
}

export interface WhatsAppWindow {
  open: boolean;
  reason: string;
  last_inbound_at?: string | null;
  opt_in: boolean;
  connected: boolean;
  now?: string;
}

/* ------------------------------------------------------------------ forecast */

export type ForecastPeriod = "month" | "quarter" | "custom";
export type ForecastGroupBy = "stage" | "owner" | "pipeline" | "team";

export interface ForecastMoney {
  count: number;
  amount: string;
}

export interface ForecastRow {
  id: string;
  label: string;
  count: number;
  amount: string;
  weighted: string;
  committed: string;
  won_count: number;
  won_amount: string;
}

export interface Forecast {
  period: ForecastPeriod;
  from: string;
  to: string;
  currency: string;
  pipeline: NamedRef | null;
  group_by: ForecastGroupBy;
  totals: {
    pipeline: ForecastMoney;
    weighted: ForecastMoney;
    committed: ForecastMoney;
    best_case: ForecastMoney;
    won: ForecastMoney;
    lost: ForecastMoney;
    expected_revenue: string;
  };
  coverage: { open_deals: number; in_period: number; without_close_date: number; overdue: number };
  breakdown: ForecastRow[];
  series: { month: string; open_count: number; pipeline: string; weighted: string; won_count: number; won: string }[];
  committed_probability: number;
}

/* ------------------------------------------------------------------ AI (drafts a person reviews) */

export const AI_STYLES = ["short", "professional", "friendly", "persuasive"] as const;
export type AIStyle = (typeof AI_STYLES)[number];
export const AI_EMAIL_PURPOSES = [
  { value: "follow_up_meeting", label: "Follow-up after meeting" },
  { value: "send_proposal", label: "Send proposal" },
  { value: "re_engage", label: "Re-engage customer" },
  { value: "thank_customer", label: "Thank customer" },
  { value: "ask_for_decision", label: "Ask for decision" },
  { value: "schedule_meeting", label: "Schedule meeting" },
  { value: "custom", label: "Custom" },
] as const;
export type AIEmailPurpose = (typeof AI_EMAIL_PURPOSES)[number]["value"];
export const AI_TONES = ["professional", "friendly", "concise", "persuasive"] as const;
export type AITone = (typeof AI_TONES)[number];
export type AIEmailOperation = "generate" | "shorten" | "rewrite" | "professional" | "friendly";

export interface DealSummary {
  headline: string;
  value: string;
  recent_activity: string;
  customer_concern: string;
  next_action: string;
  expected_close: string;
  risks: string[];
  sources: string[];
  flagged_input: boolean;
  label: string;
  cached: boolean;
}

export interface FollowUpDraft {
  draft: string;
  style: AIStyle;
  channel: "email" | "whatsapp";
  sources: string[];
  flagged_input: boolean;
}

export interface EmailDraft {
  subject: string;
  body: string;
  purpose: AIEmailPurpose;
  tone: AITone;
  operation: AIEmailOperation;
  sources: string[];
  flagged_input: boolean;
}

export interface AIUsage {
  since: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  estimated_cost_usd: string;
  flagged_inputs: number;
  by_feature: { feature: string; requests: number; cost: string }[];
  by_member: { membership_id: string; display_name: string; requests: number; cost: string }[];
  tokens_today: number;
  limits: { user_requests_per_hour: number; org_tokens_per_day: number; model_fast: string; model_strong: string };
}

/** Query-string parameters accepted by every list endpoint (plus entity-specific filters). */
export type ListParams = Record<string, string | undefined>;

/** Plural API path segment for each entity type. */
export const ENTITY_PATHS: Record<EntityType, "contacts" | "companies" | "deals" | "products"> = {
  contact: "contacts",
  company: "companies",
  deal: "deals",
  product: "products",
};

export const ENTITY_LABELS: Record<SearchEntityType, { singular: string; plural: string }> = {
  contact: { singular: "Contact", plural: "Contacts" },
  company: { singular: "Company", plural: "Companies" },
  deal: { singular: "Deal", plural: "Deals" },
  product: { singular: "Product", plural: "Products" },
  activity: { singular: "Activity", plural: "Activities" },
};
