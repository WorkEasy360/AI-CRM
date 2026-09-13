/**
 * Endpoint functions for the Phase 2 CRM API. Every mutation that edits a versioned record sends the
 * `version` the client last saw; the backend answers 409 when the record moved on.
 */

import { api, requestForm } from "@/lib/api/client";
import type {
  Board,
  BulkResult,
  Company,
  CompanyInput,
  CompanyStats,
  Contact,
  ContactInput,
  ContactStats,
  CustomFieldCreateInput,
  CustomFieldDefinition,
  CustomFieldUpdateInput,
  Deal,
  DealContactLink,
  DealInput,
  DealLine,
  DealLineInput,
  EntityType,
  ExportJob,
  ImportJob,
  ListParams,
  Note,
  Pipeline,
  PipelineStage,
  Product,
  ProductInput,
  SearchResponse,
  StageHistoryEntry,
  StageInput,
  Tag,
  TagRef,
  TimelineEvent,
} from "@/lib/api/crm-types";
import type { Paginated } from "@/lib/api/types";

const enc = encodeURIComponent;

/* ------------------------------------------------------------------ generic records */

type RecordPath = "contacts" | "companies" | "products" | "deals";

export function listRecords<T>(path: RecordPath, params: ListParams, cursor?: string | null) {
  return api.get<Paginated<T>>(`/api/v1/${path}/`, { ...params, cursor: cursor ?? undefined });
}

export const countRecords = (path: RecordPath, params: ListParams) =>
  api.get<{ count: number }>(`/api/v1/${path}/count/`, params);

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

export const listCompanies = (params: ListParams, cursor?: string | null) => listRecords<Company>("companies", params, cursor);
export const getCompany = (id: string) => getRecord<Company>("companies", id);
export const createCompany = (input: CompanyInput) => createRecord<Company, CompanyInput>("companies", input);
export const updateCompany = (id: string, version: number, input: CompanyInput) =>
  updateRecord<Company, CompanyInput>("companies", id, version, input);
export const companyStats = () => api.get<CompanyStats>("/api/v1/companies/stats/");

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
export const getTimeline = (entity_type: EntityType, entity_id: string) =>
  api.get<{ results: TimelineEvent[] }>("/api/v1/timeline/", { entity_type, entity_id });
export const globalSearch = (q: string, types?: EntityType[], signal?: AbortSignal) =>
  api.get<SearchResponse>("/api/v1/search/", { q, types: types?.join(",") }, signal);

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
