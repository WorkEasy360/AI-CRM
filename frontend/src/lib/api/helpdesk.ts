import { api } from "@/lib/api/client";
import type { Paginated } from "@/lib/api/types";

export const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export const TICKET_CATEGORIES = ["technical", "billing", "account", "support", "sales", "other"] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export interface Ticket {
  id: string;
  number: number;
  subject: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  category: TicketCategory;
  product: { id: string; name: string } | null;
  contact: { id: string; display_name: string } | null;
  /** The requester's company; null when there is none or the member may not see companies. */
  company: { id: string; name: string } | null;
  requester_name: string;
  /** The contact's name when there is one, else ``requester_name``. */
  requester: string;
  owner: { id: string; display_name: string } | null;
  /** When the SLA for this priority runs out (from creation). */
  due_at: string | null;
  is_overdue: boolean;
  /** 1-5, only once resolved. */
  rating: number | null;
  resolved_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface TicketInput {
  subject?: string;
  description?: string;
  status?: TicketStatus;
  priority?: TicketPriority;
  category?: TicketCategory;
  product_id?: string | null;
  contact_id?: string | null;
  requester_name?: string;
  owner_id?: string | null;
  rating?: number | null;
}

export interface TicketSummary {
  total: number;
  open: number;
  in_progress: number;
  resolved: number;
  overdue: number;
  /** Share of rated tickets rated 4 or 5; null when nothing is rated yet. */
  satisfaction: number | null;
  rated: number;
  /** Tickets created in the last 30 days, and the average time to resolve those resolved in that time. */
  created: number;
  avg_resolution_seconds: number | null;
  previous: { days: number; created: number; avg_resolution_seconds: number | null };
  sla_hours: Record<TicketPriority, number>;
}

export type TicketMessageKind = "reply" | "customer" | "note";
export type TicketChannel = "" | "email" | "whatsapp";

export interface TicketMessage {
  id: string;
  kind: TicketMessageKind;
  channel: TicketChannel;
  author: { id: string; display_name: string } | null;
  author_name: string;
  body: string;
  created_at: string;
}

export interface TicketActivity {
  id: string;
  action: string;
  label: string;
  actor: string;
  created_at: string;
}

export const helpdeskKeys = {
  all: ["helpdesk"] as const,
  list: (params: Record<string, string | undefined>) => ["helpdesk", "list", params] as const,
  detail: (id: string) => ["helpdesk", "ticket", id] as const,
  messages: (id: string) => ["helpdesk", "ticket", id, "messages"] as const,
  activity: (id: string) => ["helpdesk", "ticket", id, "activity"] as const,
  summary: ["helpdesk", "summary"] as const,
  sla: ["helpdesk", "sla"] as const,
};

const enc = encodeURIComponent;

export const listTickets = (params: Record<string, string | undefined>, cursor?: string | null) =>
  api.get<Paginated<Ticket>>("/api/v1/tickets/", { ...params, cursor: cursor ?? undefined });
export const getTicket = (id: string) => api.get<Ticket>(`/api/v1/tickets/${enc(id)}/`);
export const ticketSummary = () => api.get<TicketSummary>("/api/v1/tickets/summary/");
export const createTicket = (input: TicketInput) => api.post<Ticket>("/api/v1/tickets/", input);
export const updateTicket = (id: string, version: number, input: TicketInput) =>
  api.patch<Ticket>(`/api/v1/tickets/${enc(id)}/`, { ...input, version });
export const deleteTicket = (id: string) => api.delete(`/api/v1/tickets/${enc(id)}/`);
export const listTicketMessages = (id: string) => api.get<{ results: TicketMessage[] }>(`/api/v1/tickets/${enc(id)}/messages/`);
export const addTicketMessage = (id: string, input: { kind: TicketMessageKind; body: string; send_via?: TicketChannel }) =>
  api.post<TicketMessage>(`/api/v1/tickets/${enc(id)}/messages/`, input);
export const ticketActivity = (id: string) => api.get<{ results: TicketActivity[] }>(`/api/v1/tickets/${enc(id)}/activity/`);
export const mergeTicket = (id: string, into: string) => api.post<Ticket>(`/api/v1/tickets/${enc(id)}/merge/`, { into });
export const getTicketSla = () => api.get<Record<TicketPriority, number>>("/api/v1/tickets/sla/");
export const updateTicketSla = (hours: Partial<Record<TicketPriority, number>>) => api.put<Record<TicketPriority, number>>("/api/v1/tickets/sla/", hours);

/** "#TK-1045": how a ticket is named everywhere. */
export const ticketLabel = (ticket: Pick<Ticket, "number">) => `#TK-${ticket.number}`;

/** "4h 36m", "2d 3h", "12m". */
export function formatDurationShort(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const minutes = Math.max(0, Math.round(seconds / 60));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}
