/**
 * Endpoint functions for the CRM API. Every mutation that edits a versioned record sends the
 * `version` the client last saw; the backend answers 409 when the record moved on.
 */

import { api, requestForm } from "@/lib/api/client";
import type {
  Activity,
  ActivityInput,
  ActivitySummary,
  AIEmailOperation,
  AIEmailPurpose,
  AIStyle,
  AITone,
  AISettings,
  AIUsage,
  AssistantAnswer,
  AssistantConversation,
  AssistantHome,
  Board,
  BulkResult,
  Company,
  CompanyDuplicate,
  CompanyInput,
  CompanyStats,
  Contact,
  ContactDuplicate,
  ContactInput,
  ContactStats,
  CustomFieldCreateInput,
  CustomFieldDefinition,
  CustomFieldUpdateInput,
  Deal,
  DealContactLink,
  DealInput,
  DealInsights,
  DealLine,
  DealLineInput,
  DealSummary,
  EmailAccount,
  EmailDraft,
  EmailMessage,
  EmailProvider,
  EmailProviderOption,
  EmailSendInput,
  EmailTemplate,
  EmailTemplateInput,
  EntityType,
  ExportJob,
  FileAttachment,
  FollowUpDraft,
  Forecast,
  ForecastGroupBy,
  ForecastPeriod,
  ImportJob,
  LeadScore,
  ListParams,
  Note,
  Notification,
  NotificationPreferences,
  Pipeline,
  PipelineStage,
  Product,
  ProductInput,
  RelatedEntityType,
  SearchEntityType,
  SearchResponse,
  StageHistoryEntry,
  StageInput,
  Tag,
  TagRef,
  TimelineEvent,
  WhatsAppAccountStatus,
  WhatsAppMessage,
  WhatsAppSendInput,
  WhatsAppTemplate,
  WhatsAppWindow,
} from "@/lib/api/crm-types";
import type { Paginated } from "@/lib/api/types";

const enc = encodeURIComponent;

/* ------------------------------------------------------------------ generic records */

type RecordPath = "contacts" | "companies" | "products" | "deals";

export function listRecords<T>(path: RecordPath, params: ListParams, cursor?: string | null) {
  return api.get<Paginated<T>>(`/api/v1/${path}/`, { ...params, cursor: cursor ?? undefined });
}

export const countRecords = (path: RecordPath, params: ListParams) =>
  // `exact` is false when the server stopped counting at its cap (LIST_COUNT_CAP); show "count+" then.
  api.get<{ count: number; exact: boolean }>(`/api/v1/${path}/count/`, params);

export const getRecord = <T>(path: RecordPath, id: string) => api.get<T>(`/api/v1/${path}/${enc(id)}/`);

export const createRecord = <T, I>(path: RecordPath, input: I) => api.post<T>(`/api/v1/${path}/`, input);

export const updateRecord = <T, I>(path: RecordPath, id: string, version: number, input: I) =>
  api.patch<T>(`/api/v1/${path}/${enc(id)}/`, { ...input, version });

export const archiveRecord = (path: RecordPath, id: string) => api.delete(`/api/v1/${path}/${enc(id)}/`);

export const restoreRecord = <T>(path: RecordPath, id: string) => api.post<T>(`/api/v1/${path}/${enc(id)}/restore/`);

export const setRecordTags = (path: RecordPath, id: string, tag_ids: string[]) =>
  api.put<{ tags: TagRef[] }>(`/api/v1/${path}/${enc(id)}/tags/`, { tag_ids });

export const bulkAction = (
  path: Exclude<RecordPath, "products">,
  input: { ids: string[]; action: "archive" | "restore" | "reassign" | "add_tag" | "remove_tag"; payload?: Record<string, string> },
) => api.post<BulkResult>(`/api/v1/${path}/bulk/`, input);

/* ------------------------------------------------------------------ contacts / companies / products */

export const listContacts = (params: ListParams, cursor?: string | null) => listRecords<Contact>("contacts", params, cursor);
export const getContact = (id: string) => getRecord<Contact>("contacts", id);
export const createContact = (input: ContactInput) => createRecord<Contact, ContactInput>("contacts", input);
export const updateContact = (id: string, version: number, input: ContactInput) =>
  updateRecord<Contact, ContactInput>("contacts", id, version, input);
export const contactStats = () => api.get<ContactStats>("/api/v1/contacts/stats/");
/** Possible duplicates of a contact being created (same email, phone digits or full name), within the caller's scope. */
export const findContactDuplicates = (
  input: { email?: string; phone?: string; first_name?: string; last_name?: string; exclude?: string },
  signal?: AbortSignal,
) => api.get<{ results: ContactDuplicate[] }>("/api/v1/contacts/duplicates/", input, signal);
export const getContactScore = (id: string) => api.get<LeadScore>(`/api/v1/ai/contacts/${enc(id)}/score/`);

export const listCompanies = (params: ListParams, cursor?: string | null) => listRecords<Company>("companies", params, cursor);
export const getCompany = (id: string) => getRecord<Company>("companies", id);
export const createCompany = (input: CompanyInput) => createRecord<Company, CompanyInput>("companies", input);
export const updateCompany = (id: string, version: number, input: CompanyInput) =>
  updateRecord<Company, CompanyInput>("companies", id, version, input);
export const companyStats = () => api.get<CompanyStats>("/api/v1/companies/stats/");
export const findCompanyDuplicates = (input: { name?: string; website?: string; exclude?: string }, signal?: AbortSignal) =>
  api.get<{ results: CompanyDuplicate[] }>("/api/v1/companies/duplicates/", input, signal);

export const listProducts = (params: ListParams, cursor?: string | null) => listRecords<Product>("products", params, cursor);
export const getProduct = (id: string) => getRecord<Product>("products", id);
export const createProduct = (input: ProductInput) => createRecord<Product, ProductInput>("products", input);
export const updateProduct = (id: string, version: number, input: ProductInput) =>
  updateRecord<Product, ProductInput>("products", id, version, input);

/* ------------------------------------------------------------------ pipelines */

export const listPipelines = (archived = false) =>
  api.get<Paginated<Pipeline>>("/api/v1/pipelines/", archived ? { archived: "true" } : undefined);
export const getPipeline = (id: string) => api.get<Pipeline>(`/api/v1/pipelines/${enc(id)}/`);
export const createPipeline = (input: { name: string; stages?: StageInput[] }) => api.post<Pipeline>("/api/v1/pipelines/", input);
export const updatePipeline = (id: string, input: { name?: string; is_default?: boolean; position?: number; version?: number }) =>
  api.patch<Pipeline>(`/api/v1/pipelines/${enc(id)}/`, input);
export const archivePipeline = (id: string) => api.delete(`/api/v1/pipelines/${enc(id)}/`);
export const addStage = (pipelineId: string, input: StageInput) =>
  api.post<PipelineStage>(`/api/v1/pipelines/${enc(pipelineId)}/stages/`, input);
export const reorderStages = (pipelineId: string, stage_ids: string[]) =>
  api.post<{ stages: PipelineStage[] }>(`/api/v1/pipelines/${enc(pipelineId)}/stages/reorder/`, { stage_ids });
export const updateStage = (id: string, input: StageInput) => api.patch<PipelineStage>(`/api/v1/stages/${enc(id)}/`, input);
export const archiveStage = (id: string) => api.delete(`/api/v1/stages/${enc(id)}/`);

/* ------------------------------------------------------------------ deals */

export const listDeals = (params: ListParams, cursor?: string | null) => listRecords<Deal>("deals", params, cursor);
export const getDeal = (id: string) => getRecord<Deal>("deals", id);
export const createDeal = (input: DealInput) => createRecord<Deal, DealInput>("deals", input);
export const updateDeal = (id: string, version: number, input: DealInput) => updateRecord<Deal, DealInput>("deals", id, version, input);
export const getBoard = (pipelineId: string | undefined, params: ListParams = {}) =>
  api.get<Board>("/api/v1/deals/board/", { ...params, pipeline: pipelineId });
export const moveDealStage = (id: string, version: number, stage_id: string, lost_reason?: string) =>
  api.post<Deal>(`/api/v1/deals/${enc(id)}/stage/`, { stage_id, version, ...(lost_reason ? { lost_reason } : {}) });
export const dealHistory = (id: string) => api.get<{ results: StageHistoryEntry[] }>(`/api/v1/deals/${enc(id)}/history/`);
export const dealLines = (id: string) => api.get<{ results: DealLine[] }>(`/api/v1/deals/${enc(id)}/products/`);
export const addDealLine = (id: string, input: DealLineInput) => api.post<DealLine>(`/api/v1/deals/${enc(id)}/products/add/`, input);
export const updateDealLine = (id: string, lineId: string, input: DealLineInput) =>
  api.patch<DealLine>(`/api/v1/deals/${enc(id)}/products/${enc(lineId)}/`, input);
export const removeDealLine = (id: string, lineId: string) => api.post(`/api/v1/deals/${enc(id)}/products/${enc(lineId)}/remove/`);
export const dealContacts = (id: string) => api.get<{ results: DealContactLink[] }>(`/api/v1/deals/${enc(id)}/contacts/`);
export const addDealContact = (id: string, contact_id: string, role_label = "") =>
  api.post<DealContactLink>(`/api/v1/deals/${enc(id)}/contacts/add/`, { contact_id, role_label });
export const removeDealContact = (id: string, contact_id: string) =>
  api.post(`/api/v1/deals/${enc(id)}/contacts/remove/`, { contact_id });
/** Rules-based risk, next best action and lead score for one deal (no LLM call). */
export const getDealInsights = (id: string) => api.get<DealInsights>(`/api/v1/deals/${enc(id)}/insights/`);

/* ------------------------------------------------------------------ custom fields / tags */

export const listCustomFields = (entity_type?: EntityType, archived = false) =>
  api.get<Paginated<CustomFieldDefinition>>("/api/v1/custom-fields/", {
    entity_type,
    archived: archived ? "true" : undefined,
    limit: 200,
  });
export const createCustomField = (input: CustomFieldCreateInput) => api.post<CustomFieldDefinition>("/api/v1/custom-fields/", input);
export const updateCustomField = (id: string, input: CustomFieldUpdateInput) =>
  api.patch<CustomFieldDefinition>(`/api/v1/custom-fields/${enc(id)}/`, input);
export const archiveCustomField = (id: string) => api.delete(`/api/v1/custom-fields/${enc(id)}/`);
export const restoreCustomField = (id: string) => api.post<CustomFieldDefinition>(`/api/v1/custom-fields/${enc(id)}/restore/`);

export const listTags = () => api.get<Paginated<Tag>>("/api/v1/tags/", { limit: 200 });
export const createTag = (input: { name: string; color_token?: string }) => api.post<Tag>("/api/v1/tags/", input);
export const updateTag = (id: string, input: { name?: string; color_token?: string }) => api.patch<Tag>(`/api/v1/tags/${enc(id)}/`, input);
export const deleteTag = (id: string) => api.delete(`/api/v1/tags/${enc(id)}/`);

/* ------------------------------------------------------------------ notes / timeline / search */

export const listNotes = (entity_type: EntityType, entity_id: string, cursor?: string | null) =>
  api.get<Paginated<Note>>("/api/v1/notes/", { entity_type, entity_id, cursor: cursor ?? undefined });
export const createNote = (input: { entity_type: EntityType; entity_id: string; body: string; pinned?: boolean }) =>
  api.post<Note>("/api/v1/notes/", input);
export const updateNote = (id: string, input: { body?: string; pinned?: boolean }) => api.patch<Note>(`/api/v1/notes/${enc(id)}/`, input);
export const deleteNote = (id: string) => api.delete(`/api/v1/notes/${enc(id)}/`);

/* ------------------------------------------------------------------ files */

export const listFiles = (entity_type: EntityType, entity_id: string) =>
  api.get<Paginated<FileAttachment>>("/api/v1/files/", { entity_type, entity_id });
export const uploadFile = (input: { entity_type: EntityType; entity_id: string; file: File }) => {
  const form = new FormData();
  form.append("entity_type", input.entity_type);
  form.append("entity_id", input.entity_id);
  form.append("file", input.file);
  return requestForm<FileAttachment>("/api/v1/files/", form);
};
export const deleteFile = (id: string) => api.delete(`/api/v1/files/${enc(id)}/`);
/** Authenticated, audited download; the API always answers with an attachment disposition. */
export const fileDownloadUrl = (id: string) => `/api/v1/files/${enc(id)}/download/`;
/** `kinds` narrows the feed to event families (see TIMELINE_FILTERS), e.g. ["note", "activity"]. */
export const getTimeline = (entity_type: EntityType, entity_id: string, kinds?: string[]) =>
  api.get<{ results: TimelineEvent[] }>("/api/v1/timeline/", { entity_type, entity_id, kinds: kinds?.length ? kinds.join(",") : undefined });
export const globalSearch = (q: string, types?: SearchEntityType[], signal?: AbortSignal) =>
  api.get<SearchResponse>("/api/v1/search/", { q, types: types?.join(",") }, signal);

/* ------------------------------------------------------------------ activities (tasks, calls, meetings) */

export const listActivities = (params: ListParams, cursor?: string | null) =>
  api.get<Paginated<Activity>>("/api/v1/activities/", { ...params, cursor: cursor ?? undefined });
export const getActivity = (id: string) => api.get<Activity>(`/api/v1/activities/${enc(id)}/`);
export const createActivity = (input: ActivityInput) => api.post<Activity>("/api/v1/activities/", input);
export const updateActivity = (id: string, version: number, input: ActivityInput) =>
  api.patch<Activity>(`/api/v1/activities/${enc(id)}/`, { ...input, version });
export const deleteActivity = (id: string) => api.delete(`/api/v1/activities/${enc(id)}/`);
export const completeActivity = (id: string, version: number, input: { outcome?: string; note?: string } = {}) =>
  api.post<Activity>(`/api/v1/activities/${enc(id)}/complete/`, { ...input, version });
export const reopenActivity = (id: string, version: number) => api.post<Activity>(`/api/v1/activities/${enc(id)}/reopen/`, { version });
/** All activities starting between two ISO dates (max 62 days) for the calendar views. */
export const calendarActivities = (from: string, to: string, params: { owner?: "me"; kind?: string } = {}) =>
  api.get<{ results: Activity[] }>("/api/v1/activities/calendar/", { from, to, ...params });
export const activitySummary = (owner?: "me") => api.get<ActivitySummary>("/api/v1/activities/summary/", { owner });
/** Activities linked to one record (newest first). */
export const listRecordActivities = (entity: RelatedEntityType, id: string, params: ListParams = {}, cursor?: string | null) =>
  listActivities({ ...params, [entity]: id, sort: params.sort ?? "-start_at" }, cursor);

/* ------------------------------------------------------------------ notifications */

export const listNotifications = (unread = false, cursor?: string | null) =>
  api.get<Paginated<Notification>>("/api/v1/notifications/", { unread: unread ? "true" : undefined, cursor: cursor ?? undefined });
export const unreadNotificationCount = () => api.get<{ count: number }>("/api/v1/notifications/unread-count/");
export const markNotificationsRead = (ids: string[]) => api.post<{ updated: number }>("/api/v1/notifications/read/", { ids });
export const markAllNotificationsRead = () => api.post<{ updated: number }>("/api/v1/notifications/read-all/");
export const getNotificationPreferences = () => api.get<NotificationPreferences>("/api/v1/notifications/preferences/");
export const updateNotificationPreferences = (input: Partial<Pick<NotificationPreferences, "in_app" | "email" | "deal_inactive_days">>) =>
  api.patch<NotificationPreferences>("/api/v1/notifications/preferences/", input);

/* ------------------------------------------------------------------ email */

export const listEmailAccounts = () => api.get<Paginated<EmailAccount>>("/api/v1/email/accounts/");
export const listEmailProviders = () => api.get<{ results: EmailProviderOption[] }>("/api/v1/email/accounts/providers/");
/** Returns the provider's OAuth URL; the browser navigates there and comes back to /settings/email. */
export const connectEmailAccount = (provider: EmailProvider) =>
  api.post<{ authorization_url: string }>("/api/v1/email/accounts/connect/", { provider });
export const disconnectEmailAccount = (id: string) => api.delete(`/api/v1/email/accounts/${enc(id)}/`);

export const listEmailTemplates = () => api.get<Paginated<EmailTemplate>>("/api/v1/email/templates/", { limit: 200 });
export const createEmailTemplate = (input: EmailTemplateInput) => api.post<EmailTemplate>("/api/v1/email/templates/", input);
export const updateEmailTemplate = (id: string, input: EmailTemplateInput) =>
  api.patch<EmailTemplate>(`/api/v1/email/templates/${enc(id)}/`, input);
export const deleteEmailTemplate = (id: string) => api.delete(`/api/v1/email/templates/${enc(id)}/`);
export const renderEmailTemplate = (id: string, params: { contact?: string; deal?: string }) =>
  api.get<{ subject: string; body: string }>(`/api/v1/email/templates/${enc(id)}/render/`, params);

/** Email history for one record (visible when the record is), newest first. */
export const listRecordEmails = (entity: RelatedEntityType, id: string, cursor?: string | null) =>
  api.get<Paginated<EmailMessage>>("/api/v1/email/messages/", { [entity]: id, cursor: cursor ?? undefined });
export const getEmailMessage = (id: string) => api.get<EmailMessage>(`/api/v1/email/messages/${enc(id)}/`);
/** Queue an email from the caller's connected mailbox. Attachments go as multipart. */
export const sendEmail = (input: EmailSendInput, attachments: File[] = []) => {
  if (attachments.length === 0) return api.post<EmailMessage>("/api/v1/email/messages/", input);
  const form = new FormData();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) form.append(key, value.join(","));
    else form.append(key, String(value));
  }
  for (const file of attachments) form.append("attachments", file, file.name);
  return requestForm<EmailMessage>("/api/v1/email/messages/", form);
};

/* ------------------------------------------------------------------ whatsapp */

export const getWhatsAppAccount = () => api.get<WhatsAppAccountStatus>("/api/v1/whatsapp/account/");
export const connectWhatsAppAccount = (input: { phone_number_id: string; access_token: string; business_account_id?: string }) =>
  api.post<WhatsAppAccountStatus>("/api/v1/whatsapp/account/", input);
export const disconnectWhatsAppAccount = () => api.delete("/api/v1/whatsapp/account/");
export const listWhatsAppTemplates = () => api.get<Paginated<WhatsAppTemplate>>("/api/v1/whatsapp/templates/", { limit: 200 });
export const createWhatsAppTemplate = (input: { name: string; language?: string; category?: string; body?: string }) =>
  api.post<WhatsAppTemplate>("/api/v1/whatsapp/templates/", input);
export const deleteWhatsAppTemplate = (id: string) => api.delete(`/api/v1/whatsapp/templates/${enc(id)}/`);
/** Conversation with a contact (oldest first) or messages linked to a deal. */
export const listWhatsAppMessages = (entity: "contact" | "deal", id: string, cursor?: string | null) =>
  api.get<Paginated<WhatsAppMessage>>("/api/v1/whatsapp/messages/", { [entity]: id, cursor: cursor ?? undefined });
export const sendWhatsApp = (input: WhatsAppSendInput) => api.post<WhatsAppMessage>("/api/v1/whatsapp/messages/", input);
export const whatsAppWindow = (contactId: string) => api.get<WhatsAppWindow>("/api/v1/whatsapp/messages/window/", { contact: contactId });

/* ------------------------------------------------------------------ forecast */

export const getForecast = (params: { period?: ForecastPeriod; from?: string; to?: string; pipeline?: string; group_by?: ForecastGroupBy }) =>
  api.get<Forecast>("/api/v1/forecast/", params);

/* ------------------------------------------------------------------ AI (drafts only; a person reviews and sends) */

export const summarizeDeal = (id: string, force = false) => api.post<DealSummary>(`/api/v1/ai/deals/${enc(id)}/summary/`, { force });
export const generateFollowUp = (input: { entity_type: "deal" | "contact"; entity_id: string; tone?: AIStyle; channel?: "email" | "whatsapp" }) =>
  api.post<FollowUpDraft>("/api/v1/ai/follow-up/", input);
export const draftEmailWithAI = (input: {
  contact_id?: string | null;
  deal_id?: string | null;
  purpose?: AIEmailPurpose;
  tone?: AITone;
  operation?: AIEmailOperation;
  text?: string;
  instructions?: string;
}) => api.post<EmailDraft>("/api/v1/ai/email/", input);
export const getAIUsage = () => api.get<AIUsage>("/api/v1/ai/usage/");
export const getAISettings = () => api.get<AISettings>("/api/v1/ai/settings/");
export const updateAISettings = (input: { ai_enabled?: boolean; monthly_budget_usd?: string; user_requests_per_hour?: number }) =>
  api.put<AISettings>("/api/v1/ai/settings/", input);

/* ------------------------------------------------------------------ Ask Keel (one assistant, every mode) */

/** Always answers: with a model when one is available, from CRM + knowledge retrieval otherwise. */
export const askKeel = (input: { question: string; conversation_id?: string | null }) =>
  api.post<AssistantAnswer>("/api/v1/assistant/ask/", input);
export const getAssistantHome = () => api.get<AssistantHome>("/api/v1/assistant/home/");
export const getAssistantConversation = (id: string) =>
  api.get<AssistantConversation>(`/api/v1/assistant/conversations/${enc(id)}/`);
export const deleteAssistantConversation = (id: string) => api.delete(`/api/v1/assistant/conversations/${enc(id)}/`);

/* ------------------------------------------------------------------ import / export */

export type ImportEntity = "contacts" | "companies" | "products";
export type ExportEntity = "contacts" | "companies" | "products" | "deals";

export const uploadImport = (entity: ImportEntity, file: File) => {
  const form = new FormData();
  form.append("file", file, file.name);
  return requestForm<ImportJob>(`/api/v1/imports/${entity}/`, form);
};
export const listImports = (entity: ImportEntity, cursor?: string | null) =>
  api.get<Paginated<ImportJob>>(`/api/v1/imports/${entity}/`, { cursor: cursor ?? undefined });
export const getImport = (entity: ImportEntity, id: string) => api.get<ImportJob>(`/api/v1/imports/${entity}/${enc(id)}/`);
export const startImport = (entity: ImportEntity, id: string, mapping: Record<string, string>, options?: Record<string, boolean>) =>
  api.post<ImportJob>(`/api/v1/imports/${entity}/${enc(id)}/start/`, { mapping, options: options ?? {} });

export const createExport = (entity: ExportEntity, filters: Record<string, string> = {}) =>
  api.post<ExportJob>(`/api/v1/exports/${entity}/`, { filters });
export const listExports = (entity: ExportEntity, cursor?: string | null) =>
  api.get<Paginated<ExportJob>>(`/api/v1/exports/${entity}/`, { cursor: cursor ?? undefined });
export const getExport = (entity: ExportEntity, id: string) => api.get<ExportJob>(`/api/v1/exports/${entity}/${enc(id)}/`);
/** Same-origin download URL; the browser sends the session cookie and receives a CSV attachment. */
export const exportDownloadUrl = (entity: ExportEntity, id: string) => `/api/v1/exports/${entity}/${enc(id)}/download/`;
