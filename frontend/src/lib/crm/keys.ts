import type { EntityType, ListParams, RelatedEntityType } from "@/lib/api/crm-types";

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
  dealInsights: (id: string) => ["crm", "deals", id, "insights"] as const,
  dealSummary: (id: string) => ["crm", "deals", id, "summary"] as const,
  contactScore: (id: string) => ["crm", "contacts", id, "score"] as const,
  customFields: (entity?: EntityType, archived = false) => ["crm", "custom-fields", entity ?? "all", archived] as const,
  tags: ["crm", "tags"] as const,
  notes: (entity: EntityType, id: string) => ["crm", "notes", entity, id] as const,
  files: (entity: EntityType, id: string) => ["crm", "files", entity, id] as const,
  timeline: (entity: EntityType, id: string, kinds?: string[]) => ["crm", "timeline", entity, id, kinds ?? []] as const,
  search: (q: string) => ["crm", "search", q] as const,
  imports: (entity: string) => ["crm", "imports", entity] as const,
  importJob: (entity: string, id: string) => ["crm", "imports", entity, id] as const,
  exports: (entity: string) => ["crm", "exports", entity] as const,
  // activities
  activities: (params: ListParams) => ["crm", "activities", "list", params] as const,
  activity: (id: string) => ["crm", "activities", "record", id] as const,
  recordActivities: (entity: RelatedEntityType, id: string, params: ListParams = {}) => ["crm", "activities", "record-list", entity, id, params] as const,
  calendar: (from: string, to: string, params: Record<string, string | undefined> = {}) => ["crm", "activities", "calendar", from, to, params] as const,
  activitySummary: (owner?: string) => ["crm", "activities", "summary", owner ?? "all"] as const,
  // notifications
  notifications: (unread: boolean) => ["notifications", "list", unread] as const,
  notificationCount: ["notifications", "unread-count"] as const,
  notificationPreferences: ["notifications", "preferences"] as const,
  // email / whatsapp
  emailAccounts: ["messaging", "email", "accounts"] as const,
  emailProviders: ["messaging", "email", "providers"] as const,
  emailTemplates: ["messaging", "email", "templates"] as const,
  recordEmails: (entity: RelatedEntityType, id: string) => ["messaging", "email", "messages", entity, id] as const,
  emailMessage: (id: string) => ["messaging", "email", "message", id] as const,
  whatsappAccount: ["messaging", "whatsapp", "account"] as const,
  whatsappTemplates: ["messaging", "whatsapp", "templates"] as const,
  whatsappMessages: (entity: "contact" | "deal", id: string) => ["messaging", "whatsapp", "messages", entity, id] as const,
  whatsappWindow: (contactId: string) => ["messaging", "whatsapp", "window", contactId] as const,
  // forecast / ai
  forecast: (params: Record<string, string | undefined>) => ["forecast", params] as const,
  aiUsage: ["ai", "usage"] as const,
  aiSettings: ["ai", "settings"] as const,
  // assistant
  assistantHome: ["assistant", "home"] as const,
  assistantConversation: (id: string) => ["assistant", "conversation", id] as const,
};
