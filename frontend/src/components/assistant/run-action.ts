import { toIsoWithOffset } from "@/components/activities/activity-utils";
import { archivePipeline, archiveRecord, createActivity, createCompany, createContact, createDeal, createPipeline, deleteActivity } from "@/lib/api/crm";
import type { AssistantActionProposal } from "@/lib/api/crm-types";
import { createTicket, deleteTicket } from "@/lib/api/helpdesk";

/** What the assistant made, with the way back. */
export interface CreatedRecord {
  name: string;
  href: string;
  undo: () => Promise<unknown>;
}

/** The state of an action answer in this browser session (restored history never re-runs). */
export type ActionRun = { status: "running" } | { status: "done"; record: CreatedRecord } | { status: "undone"; record: CreatedRecord } | { status: "error"; message: string };

/** 09:00 local on the proposal's day (calls and meetings always have one: the server sends them to the form otherwise). */
function at9(date: string): string {
  return toIsoWithOffset(new Date(`${date}T09:00:00`));
}

/**
 * Create what the assistant proposed through the ordinary create endpoints, exactly as the record's own
 * form would: the server checks the permission, validates, applies plan limits and writes the audit
 * entry. Only a `ready` proposal comes here; anything else opens the pre-filled form instead.
 */
export async function runAssistantAction(action: AssistantActionProposal): Promise<CreatedRecord> {
  const links = {
    contact_id: action.links.contact?.id ?? null,
    company_id: action.links.company?.id ?? null,
    deal_id: action.links.deal?.id ?? null,
  };
  switch (action.kind) {
    case "task": {
      const activity = await createActivity({
        kind: "task",
        title: action.title,
        ...links,
        ...(action.due_date ? { start_at: toIsoWithOffset(new Date(`${action.due_date}T00:00:00`)), all_day: true } : {}),
      });
      return { name: activity.title, href: `/activities?open=${encodeURIComponent(activity.id)}`, undo: () => deleteActivity(activity.id) };
    }
    case "call":
    case "meeting": {
      const start = at9(action.due_date);
      const activity = await createActivity({
        kind: action.kind,
        title: action.title,
        start_at: start,
        ...(action.kind === "meeting"
          ? { end_at: toIsoWithOffset(new Date(new Date(start).getTime() + 30 * 60_000)), all_day: false, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
          : { duration_minutes: 15 }),
        ...links,
      });
      return { name: activity.title, href: `/activities?open=${encodeURIComponent(activity.id)}`, undo: () => deleteActivity(activity.id) };
    }
    case "deal": {
      const deal = await createDeal({
        name: action.title,
        company_id: links.company_id,
        primary_contact_id: links.contact_id,
        ...(action.due_date ? { expected_close_date: action.due_date } : {}),
      });
      return { name: deal.name, href: `/deals/${encodeURIComponent(deal.id)}`, undo: () => archiveRecord("deals", deal.id) };
    }
    case "contact": {
      const contact = await createContact({
        first_name: action.first_name ?? action.title,
        last_name: action.last_name ?? "",
        ...(action.email ? { email: action.email } : {}),
        ...(action.phone ? { phone: action.phone } : {}),
        company_id: links.company_id,
      });
      const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || action.title;
      return { name, href: `/contacts/${encodeURIComponent(contact.id)}`, undo: () => archiveRecord("contacts", contact.id) };
    }
    case "company": {
      const company = await createCompany({ name: action.title });
      return { name: company.name, href: `/companies/${encodeURIComponent(company.id)}`, undo: () => archiveRecord("companies", company.id) };
    }
    case "ticket": {
      const ticket = await createTicket({ subject: action.title, ...(links.contact_id ? { contact_id: links.contact_id } : {}) });
      return { name: ticket.subject, href: `/helpdesk?open=${encodeURIComponent(ticket.id)}`, undo: () => deleteTicket(ticket.id) };
    }
    case "pipeline": {
      const pipeline = await createPipeline({ name: action.title });
      return { name: pipeline.name, href: `/pipeline?pipeline=${encodeURIComponent(pipeline.id)}`, undo: () => archivePipeline(pipeline.id) };
    }
  }
}
