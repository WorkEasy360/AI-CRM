import { api } from "@/lib/api/client";
import type { Paginated } from "@/lib/api/types";

export const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export interface Ticket {
  id: string;
  number: number;
  subject: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  contact: { id: string; display_name: string } | null;
  requester_name: string;
  /** The contact's name when there is one, else ``requester_name``. */
  requester: string;
  owner: { id: string; display_name: string } | null;
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
  contact_id?: string | null;
  requester_name?: string;
  owner_id?: string | null;
  rating?: number | null;
}

export interface TicketSummary {
  open: number;
  in_progress: number;
  resolved: number;
  /** Share of rated tickets rated 4 or 5; null when nothing is rated yet. */
  satisfaction: number | null;
  rated: number;
}

export const helpdeskKeys = {
  all: ["helpdesk"] as const,
  list: (params: Record<string, string | undefined>) => ["helpdesk", "list", params] as const,
  summary: ["helpdesk", "summary"] as const,
};

const enc = encodeURIComponent;

export const listTickets = (params: Record<string, string | undefined>, cursor?: string | null) =>
  api.get<Paginated<Ticket>>("/api/v1/tickets/", { ...params, cursor: cursor ?? undefined });
export const ticketSummary = () => api.get<TicketSummary>("/api/v1/tickets/summary/");
export const createTicket = (input: TicketInput) => api.post<Ticket>("/api/v1/tickets/", input);
export const updateTicket = (id: string, version: number, input: TicketInput) =>
  api.patch<Ticket>(`/api/v1/tickets/${enc(id)}/`, { ...input, version });
export const deleteTicket = (id: string) => api.delete(`/api/v1/tickets/${enc(id)}/`);
