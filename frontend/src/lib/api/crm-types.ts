/**
 * Hand-written types for the Phase 2 CRM API (contacts, companies, products, pipelines, deals,
 * custom fields, tags, notes, timeline, search, import/export). They mirror the backend serializers
 * one-to-one; the generated `schema.d.ts` stays the source for the Phase 1 surface.
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
}

export type DealStatus = "open" | "won" | "lost";

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
  expected_close_date: string | null;
  status: DealStatus;
  closed_at: string | null;
  lost_reason: string;
  stage_entered_at: string;
  description: string;
  line_count: number;
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

export interface TimelineEvent {
  id: string;
  kind: "record.created" | "note" | "deal.stage_changed" | "deal.linked" | string;
  occurred_at: string;
  actor: MembershipRef | null;
  data: Record<string, unknown>;
}

export interface SearchHit {
  id: string;
  type: EntityType;
  title: string;
  subtitle: string;
  meta: string;
}

export interface SearchResponse {
  query: string;
  results: Partial<Record<EntityType, SearchHit[]>>;
}

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

/** Query-string parameters accepted by every list endpoint (plus entity-specific filters). */
export type ListParams = Record<string, string | undefined>;

/** Plural API path segment for each entity type. */
export const ENTITY_PATHS: Record<EntityType, "contacts" | "companies" | "deals" | "products"> = {
  contact: "contacts",
  company: "companies",
  deal: "deals",
  product: "products",
};

export const ENTITY_LABELS: Record<EntityType, { singular: string; plural: string }> = {
  contact: { singular: "Contact", plural: "Contacts" },
  company: { singular: "Company", plural: "Companies" },
  deal: { singular: "Deal", plural: "Deals" },
  product: { singular: "Product", plural: "Products" },
};
