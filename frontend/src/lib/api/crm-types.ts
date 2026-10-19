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
  /** Stock flag: available to sell right now (not inventory tracking). */
  in_stock: boolean;
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
  in_stock?: boolean;
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

/** Field keys (module schema) a pipeline shows on its Kanban cards and deal form. */
export interface PipelineLayout {
  card_fields?: string[];
  form_fields?: string[];
}

export interface Pipeline {
  id: string;
  name: string;
  position: number;
  is_default: boolean;
  /** Set on a sub-pipeline: the team pipeline it is a variant of. */
  parent_id: string | null;
  /** Restricted: only the listed teams/roles (and pipeline managers) see it and its deals. */
  restricted: boolean;
  layout: PipelineLayout;
  /** The layout in force: its own, or its parent's for a sub-pipeline. */
  effective_layout: PipelineLayout;
  template_key: string;
  access: { team_ids: string[]; hierarchy_role_ids: string[] };
  stages: PipelineStage[];
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PipelineTemplate {
  key: string;
  name: string;
  description: string;
  stages: StageInput[];
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
  /** True while product lines drive the amount (it cannot be edited by hand then). */
  amount_from_lines: boolean;
  price_book: NamedRef | null;
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
  price_book_id?: string | null;
  owner_id?: string | null;
  custom_data?: CustomData;
}

/** A product line. Money fields are absent when the member's field rules hide them. */
export interface DealLine {
  id: string;
  product: NamedRef;
  sku: string;
  quantity?: string;
  unit_price?: string;
  currency: string;
  discount_percent?: string;
  tax_rate?: string;
  /** quantity x unit price less the discount */
  subtotal?: string;
  tax_amount?: string;
  /** subtotal + tax: what the line adds to the deal amount */
  line_total?: string;
  created_at: string;
}

export interface DealLineInput {
  product_id?: string;
  quantity?: string;
  unit_price?: string;
  discount_percent?: string;
  tax_rate?: string;
  /** The deal version the client saw (optional; 409 when it moved on). */
  version?: number;
}

export interface DealConnection {
  id: string;
  direction: "outgoing" | "incoming";
  origin: "manual" | "automation";
  created_at: string;
  deal: {
    id: string;
    name: string;
    pipeline: NamedRef;
    stage: { id: string; name: string; kind: StageKind };
    status: DealStatus;
    amount?: string;
    currency: string;
    owner: MembershipRef | null;
  };
}

export interface PriceBook {
  id: string;
  name: string;
  currency: string;
  description: string;
  is_active: boolean;
  entry_count: number;
  version: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PriceBookEntry {
  id: string;
  product: { id: string; name: string; sku: string };
  unit_price?: string;
  list_price?: string;
  updated_at: string;
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

/**
 * What `/deals/board/` puts on a Kanban card — a deliberate subset of `Deal`.
 *
 * The board renders up to 300 of these, so it ships only the fields the card draws (plus `version`,
 * the concurrency token a stage move sends back). A full `Deal` satisfies this shape, so the server
 * copy returned by a stage move can stand in for a card without a conversion. It does NOT work the
 * other way round: a card has no description, tags, custom data or pipeline, so never seed the deal
 * detail cache from one — the detail page fetches the whole record.
 */
export interface DealCard {
  id: string;
  name: string;
  stage: StageRef;
  company: NamedRef | null;
  primary_contact: NamedRef | null;
  owner: MembershipRef | null;
  amount: string;
  currency: string;
  amount_base: string;
  /** amount_base x probability, computed on the server. */
  weighted_amount_base: string;
  probability: number;
  probability_overridden: boolean;
  expected_close_date: string | null;
  status: DealStatus;
  next_activity_title: string;
  risk_level: RiskLevel;
  version: number;
  /** The pipeline's card layout fields (only those the member may see). */
  extra?: { key: string; label: string; value: unknown }[];
}

export interface BoardStage extends PipelineStage {
  deal_count: number;
  /** null when the member may not see deal amounts */
  total_amount_base: string | null;
  /** sum of amount x probability over the column (server-computed) */
  weighted_amount_base: string | null;
  deals: DealCard[];
  has_more: boolean;
}

export interface Board {
  pipeline: (NamedRef & { parent_id: string | null; layout: PipelineLayout }) | null;
  /** The team pipeline and its sub-pipelines, for the board's pipeline switcher. */
  family?: { id: string; name: string; parent_id: string | null }[];
  totals?: { deal_count: number; open_amount_base: string | null; weighted_forecast_base: string | null };
  stages: BoardStage[];
}

export interface BoardStagePage {
  stage_id: string;
  offset: number;
  deals: DealCard[];
  has_more: boolean;
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

export interface FileAttachment {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  uploaded_by: MembershipRef | null;
  created_at: string;
}

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
  /** The registered timeline source that produced it (notes, activities, emails, files, ...). */
  source?: string;
}

export interface TimelinePage {
  results: TimelineEvent[];
  /** Pass back as `before` for the next (older) page; null at the beginning of the record. */
  next_before: string | null;
  sources: { key: string; label: string }[];
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

export type JobStatus =
  | "uploaded"
  | "previewing"
  | "previewed"
  | "pending"
  | "running"
  | "completed"
  | "stopped"
  | "failed"
  | "rolling_back"
  | "rolled_back";

/** The `upgrade` member of a 403 plan problem: which edition or add-on lifts a limit. */
export interface UpgradePath {
  kind?: string;
  metric?: string;
  limit?: number | null;
  used?: number;
  current_edition?: { key: string; name: string } | null;
  required_edition?: { key: string; name: string } | null;
  addon?: string | null;
  url?: string;
}

export interface ImportPreview {
  rows_checked: number;
  would_create: number;
  would_update: number;
  would_skip: number;
  would_fail: number;
  companies_to_create: number;
  errors: ImportRowError[];
  limit: { stops_at_row: number; capacity: number; message: string; upgrade: UpgradePath } | null;
}

export interface ImportPreset {
  key: string;
  label: string;
  mapping: Record<string, string>;
}

export type DedupeMode = "create" | "skip" | "update";

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
  file_format: "csv" | "xlsx";
  total_rows: number;
  processed_rows: number;
  created_rows: number;
  updated_rows: number;
  skipped_rows: number;
  error_rows: number;
  errors: ImportRowError[];
  error_message: string;
  /** The dry-run result once the file was checked (empty object before). */
  preview: ImportPreview | Record<string, never> | Record<string, string>[];
  /** Set when the import stopped at the plan's record limit. */
  stop: { row?: number; message?: string; upgrade?: UpgradePath };
  rollback: { deleted?: number; reverted?: number; missing?: number; conflict_count?: number; conflicts?: { row: number; entity_type: string; entity_id: string; reason: string }[] };
  rolled_back_at: string | null;
  requested_by: MembershipRef | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  /** First rows of the file (upload response). */
  sample?: Record<string, string>[];
  targets?: Record<string, string>;
  presets?: ImportPreset[];
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
  /** Set on a subtask: the task it belongs to. */
  parent_id: string | null;
  subtask_count: number;
  subtasks_done: number;
  /** RRULE (e.g. "FREQ=WEEKLY;BYDAY=MO"), "" when it does not repeat. */
  recurrence: string;
  series_id: string | null;
  /** Calendar occurrences of a repeating event carry the id of the event they come from. */
  occurrence_of?: string;
  occurrence_key?: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface MyDay {
  date: string;
  timezone: string;
  overdue: Activity[];
  tasks: Activity[];
  events: Activity[];
  calls: Activity[];
  no_date: Activity[];
  completed_today: number;
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
  /** Make it a subtask of this task. */
  parent_id?: string;
  /** RRULE, "" to stop repeating. */
  recurrence?: string;
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
  "integration_alert",
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
  integration_alert: "Integration needs attention",
};

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  entity_type: "deal" | "contact" | "company" | "activity" | "integration" | "webhook" | "";
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

/* ------------------------------------------------------------------ Ask Keel */

/**
 * How an answer was produced. The salesperson is never shown a provider name or a status code, only
 * whether Keel wrote the answer ("ai"/"ai_fallback") or assembled it straight from the CRM
 * ("retrieval", surfaced in the UI as "Knowledge search mode").
 */
export type AssistantMode = "ai" | "ai_fallback" | "retrieval";

export type AssistantAnswerType = "summary" | "deal_risk" | "next_action" | "crm_results" | "timeline" | "forecast" | "draft" | "answer";

/** One row inside an answer section. The shape varies by the section's `kind`. */
export interface AssistantItem {
  id?: string;
  type?: string;
  label?: string;
  title?: string;
  subtitle?: string;
  meta?: string;
  snippet?: string;
  occurred_at?: string | null;
  href?: string;
  /** Money, already scoped and computed server-side; formatted client-side for the viewer's locale. */
  amount?: string | null;
  currency?: string;
  count?: number | null;
  hint?: string;
}

export interface AssistantSection {
  title: string;
  kind: "records" | "events" | "metrics";
  items: AssistantItem[];
  hint: string;
}

/** A citation. Every source here was resolved inside the caller's permission scope. */
export interface AssistantSource {
  type: string;
  id: string;
  title: string;
  subtitle: string;
  occurred_at: string | null;
  href: string;
}

export interface AssistantAnswer {
  conversation_id: string;
  question: string;
  intent: string;
  mode: AssistantMode;
  answer_type: AssistantAnswerType;
  headline: string;
  /** Computed from CRM data by the server. Never written by the model. */
  facts: string[];
  /** The model's interpretation. Empty in retrieval mode. */
  analysis: string;
  recommendation: string;
  sections: AssistantSection[];
  sources: AssistantSource[];
  suggestions: string[];
  /** Shown verbatim when Keel could not write the answer itself. */
  notice: string;
  knowledge_search_only: boolean;
  degraded_retrieval?: boolean;
  flagged_input?: boolean;
}

export interface AssistantHome {
  suggestions: string[];
  generative_available: boolean;
  knowledge_available: boolean;
  recent: { id: string; title: string; last_message_at: string | null }[];
}

export interface AssistantConversation {
  id: string | null;
  title?: string;
  turns: { position: number; question: string; answer: string; mode: AssistantMode; created_at: string }[];
}

export interface AISettings {
  ai_enabled: boolean;
  monthly_budget_usd: string;
  month_to_date_usd: string;
  user_requests_per_hour: number;
  provider: string;
  model_strong: string;
  model_fast: string;
  model_fallback: string;
  knowledge: {
    embedding_backend: string;
    embedding_model: string;
    semantic: boolean;
    chunks: number;
    by_source: Record<string, number>;
    status: Record<string, number>;
    last_indexed_at: string | null;
    last_error: string;
  };
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

/* ------------------------------------------------------------------ module schema and generic views */

export type FieldType =
  | "text"
  | "textarea"
  | "email"
  | "phone"
  | "url"
  | "integer"
  | "number"
  | "money"
  | "percent"
  | "date"
  | "datetime"
  | "boolean"
  | "choice"
  | "multi_choice"
  | "lookup"
  | "user"
  | "tags"
  | "stage";

/** One field of a module as the signed-in member may see it (hidden fields are never listed). */
export interface FieldDescriptor {
  key: string;
  label: string;
  type: FieldType;
  editable: boolean;
  read_only: boolean;
  required: boolean;
  sortable: boolean;
  groupable: boolean;
  choices: string[];
  lookup: string | null;
  custom: boolean;
  importable: boolean;
  currency_field: string | null;
}

export interface ModuleSchema {
  entity_type: EntityType;
  label: string;
  label_plural: string;
  title_field: string;
  counts_as_record: boolean;
  default_columns: string[];
  fields: FieldDescriptor[];
}

export type CellValue = string | number | boolean | null | NamedRef | MembershipRef | TagRef[] | (NamedRef & { kind?: string }) | string[];

export interface RecordRow {
  id: string;
  version: number | null;
  title: string;
  values: Record<string, CellValue>;
}

export interface RowsResponse {
  entity_type: EntityType;
  offset: number;
  limit: number;
  total: number;
  exact: boolean;
  columns: FieldDescriptor[];
  rows: RecordRow[];
}

export interface CellError {
  code: string;
  message: string;
}

export interface RowEditResult {
  id: string;
  status: "saved" | "partial" | "conflict" | "error";
  version?: number;
  values?: Record<string, CellValue>;
  errors: Record<string, CellError>;
}

export interface EditsResponse {
  entity_type: EntityType;
  saved: number;
  failed: number;
  results: RowEditResult[];
}

export interface RecordGroup {
  value: string | boolean | null;
  label: string;
  count: number;
  rows: RecordRow[];
  has_more: boolean;
}

export interface GroupsResponse {
  entity_type: EntityType;
  group_by: FieldDescriptor;
  columns: FieldDescriptor[];
  groups: RecordGroup[];
}

export interface CalendarResponse {
  entity_type: EntityType;
  date_field: string;
  items: (RecordRow & { date: string })[];
  truncated: boolean;
}

export interface ChartResponse {
  entity_type: EntityType;
  group_by: string;
  measure: "count" | "sum";
  field: string | null;
  series: { key: string | boolean | null; label: string; value: number | string }[];
}

export type ViewKind = "list" | "kanban" | "sheet" | "calendar" | "chart";
export type ViewVisibility = "private" | "organization" | "teams";

export interface ViewConfig {
  group_by?: string;
  pipeline_id?: string;
  date_field?: string;
  include_activities?: boolean;
  measure?: "count" | "sum";
  field?: string;
}

export interface SavedView {
  id: string;
  entity_type: EntityType;
  name: string;
  kind: ViewKind;
  filters: Record<string, string>;
  sort: string;
  columns: string[];
  config: ViewConfig;
  visibility: ViewVisibility;
  team_ids: string[];
  owner: MembershipRef;
  is_owner: boolean;
  is_default: boolean;
  /** Some columns or filters use fields this member cannot see; they were left out. */
  restricted: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface SavedViewInput {
  entity_type?: EntityType;
  name?: string;
  kind?: ViewKind;
  filters?: Record<string, string>;
  sort?: string;
  columns?: string[];
  config?: ViewConfig;
  visibility?: ViewVisibility;
  team_ids?: string[];
}
