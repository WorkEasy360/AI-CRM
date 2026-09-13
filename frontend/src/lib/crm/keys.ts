import type { EntityType, ListParams } from "@/lib/api/crm-types";

/** React Query keys for the CRM modules. Lists are keyed by their full parameter set. */
export const crmKeys = {
  list: (path: string, params: ListParams) => ["crm", path, "list", params] as const,
  stats: (path: string) => ["crm", path, "stats"] as const,
  record: (path: string, id: string) => ["crm", path, "record", id] as const,
  pipelines: ["crm", "pipelines"] as const,
  board: (pipelineId: string | undefined, params: ListParams) => ["crm", "deals", "board", pipelineId ?? "default", params] as const,
  dealHistory: (id: string) => ["crm", "deals", id, "history"] as const,
  dealLines: (id: string) => ["crm", "deals", id, "lines"] as const,
  dealContacts: (id: string) => ["crm", "deals", id, "contacts"] as const,
  customFields: (entity?: EntityType, archived = false) => ["crm", "custom-fields", entity ?? "all", archived] as const,
  tags: ["crm", "tags"] as const,
  notes: (entity: EntityType, id: string) => ["crm", "notes", entity, id] as const,
  timeline: (entity: EntityType, id: string) => ["crm", "timeline", entity, id] as const,
  search: (q: string) => ["crm", "search", q] as const,
  imports: (entity: string) => ["crm", "imports", entity] as const,
  importJob: (entity: string, id: string) => ["crm", "imports", entity, id] as const,
  exports: (entity: string) => ["crm", "exports", entity] as const,
};
