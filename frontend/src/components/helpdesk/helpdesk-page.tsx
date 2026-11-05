"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock3, Headset, Plus, Search, Smile, Ticket as TicketIcon } from "lucide-react";
import { RecordPicker } from "@/components/activities/pickers";
import { KpiTile } from "@/components/dashboard/stat-tile";
import { PageHeader } from "@/components/page-header";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import type { NamedRef } from "@/lib/api/crm-types";
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  createTicket,
  helpdeskKeys,
  listTickets,
  ticketSummary,
  updateTicket,
  type Ticket,
  type TicketInput,
  type TicketPriority,
  type TicketStatus,
} from "@/lib/api/helpdesk";
import { errorMessage } from "@/lib/api/problem";
import { hasPermission, useSession } from "@/lib/session";
import { formatDateTime } from "@/lib/utils";

export const STATUS_LABELS: Record<TicketStatus, string> = { open: "Open", in_progress: "In Progress", resolved: "Resolved", closed: "Closed" };
export const PRIORITY_LABELS: Record<TicketPriority, string> = { low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };
const STATUS_BADGE: Record<TicketStatus, BadgeProps["variant"]> = { open: "accent", in_progress: "warning", resolved: "success", closed: "neutral" };
const PRIORITY_BADGE: Record<TicketPriority, BadgeProps["variant"]> = { low: "success", medium: "warning", high: "danger", urgent: "danger" };
const ALL = "__all__";

/** Support tickets: header counts, filters in one row, and the ticket list. */
export function HelpdeskPage() {
  const { data: session } = useSession();
  const active = session?.active;
  const canView = hasPermission(active, "tickets.view");
  const canCreate = hasPermission(active, "tickets.create");
  const [q, setQ] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [status, setStatus] = React.useState<string>(ALL);
  const [priority, setPriority] = React.useState<string>(ALL);
  const [editing, setEditing] = React.useState<Ticket | "new" | null>(null);

  // Debounce the search box so each keystroke is not a request.
  React.useEffect(() => {
    const id = window.setTimeout(() => setQuery(q.trim()), 300);
    return () => window.clearTimeout(id);
  }, [q]);

  const params = { q: query || undefined, status: status === ALL ? undefined : status, priority: priority === ALL ? undefined : priority };
  const tickets = useQuery({ queryKey: helpdeskKeys.list(params), queryFn: () => listTickets(params), enabled: canView, placeholderData: (prev) => prev });
  const summary = useQuery({ queryKey: helpdeskKeys.summary, queryFn: ticketSummary, enabled: canView, staleTime: 30_000 });

  if (!session) return null;
  if (!canView) {
    return <EmptyState icon={<Headset />} title="Helpdesk is not part of your role" description="Ask a workspace administrator to give your role access to tickets." />;
  }
  const s = summary.data;
  const rows = tickets.data?.results ?? [];

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Helpdesk"
        description="Support tickets from your customers."
        actions={
          canCreate ? (
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus />
              Create Ticket
            </Button>
          ) : null
        }
      />

      <section aria-label="Ticket summary" className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
        <KpiTile tone="blue" icon={<TicketIcon />} label="Open Tickets" value={s ? s.open.toLocaleString() : undefined} sub="Waiting for a first reply" />
        <KpiTile tone="amber" icon={<Clock3 />} label="In Progress" value={s ? s.in_progress.toLocaleString() : undefined} sub="Being worked on" />
        <KpiTile tone="green" icon={<CheckCircle2 />} label="Resolved" value={s ? s.resolved.toLocaleString() : undefined} sub="Resolved or closed" />
        <KpiTile
          tone="orange"
          icon={<Smile />}
          label="Satisfaction"
          value={s ? (s.satisfaction === null ? "—" : `${s.satisfaction}%`) : undefined}
          sub={s ? (s.rated ? `From ${s.rated.toLocaleString()} rated ${s.rated === 1 ? "ticket" : "tickets"}` : "No ratings yet") : undefined}
        />
      </section>

      <section aria-label="Tickets" className="mt-3 rounded-lg border border-border bg-surface shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <div className="relative min-w-48 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tickets…" aria-label="Search tickets" className="h-8 pl-8" maxLength={200} />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="h-8 w-36" aria-label="Status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All Status</SelectItem>
              {TICKET_STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {STATUS_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger className="h-8 w-36" aria-label="Priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All Priority</SelectItem>
              {TICKET_PRIORITIES.map((value) => (
                <SelectItem key={value} value={value}>
                  {PRIORITY_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {tickets.isError ? (
          <EmptyState title="Could not load tickets" description={errorMessage(tickets.error)} action={<Button variant="secondary" onClick={() => tickets.refetch()}>Retry</Button>} />
        ) : !tickets.data ? (
          <div className="p-3">
            <SkeletonRows rows={5} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Headset />}
            title={query || status !== ALL || priority !== ALL ? "No tickets match these filters" : "No tickets yet"}
            description={canCreate ? "Log a customer's request to start tracking it." : undefined}
            action={canCreate ? <Button size="sm" onClick={() => setEditing("new")}>Create Ticket</Button> : undefined}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-20">#</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Requester</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Assignee</TableHead>
                <TableHead className="hidden sm:table-cell">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((ticket) => (
                <TableRow key={ticket.id}>
                  <TableCell className="tabular-nums text-fg-muted">#{ticket.number}</TableCell>
                  <TableCell>
                    <button type="button" onClick={() => setEditing(ticket)} className="text-left font-medium text-fg hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      {ticket.subject}
                    </button>
                  </TableCell>
                  <TableCell className="text-fg-muted">{ticket.requester || "—"}</TableCell>
                  <TableCell>
                    <Badge variant={PRIORITY_BADGE[ticket.priority]}>{PRIORITY_LABELS[ticket.priority]}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_BADGE[ticket.status]}>{STATUS_LABELS[ticket.status]}</Badge>
                  </TableCell>
                  <TableCell className="hidden text-fg-muted md:table-cell">{ticket.owner?.display_name ?? "Unassigned"}</TableCell>
                  <TableCell className="hidden whitespace-nowrap text-fg-muted sm:table-cell">{formatDateTime(ticket.updated_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      {editing ? (
        <TicketDialog
          ticket={editing === "new" ? null : editing}
          canEdit={editing === "new" ? canCreate : hasPermission(active, "tickets.update")}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

/** Create a ticket, or view and edit one. The API decides whether this member may change it. */
function TicketDialog({ ticket, canEdit, onClose }: { ticket: Ticket | null; canEdit: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [subject, setSubject] = React.useState(ticket?.subject ?? "");
  const [description, setDescription] = React.useState(ticket?.description ?? "");
  const [status, setStatus] = React.useState<TicketStatus>(ticket?.status ?? "open");
  const [priority, setPriority] = React.useState<TicketPriority>(ticket?.priority ?? "medium");
  const [contact, setContact] = React.useState<NamedRef | null>(ticket?.contact ? { id: ticket.contact.id, name: ticket.contact.display_name } : null);
  const [requesterName, setRequesterName] = React.useState(ticket?.requester_name ?? "");
  const [rating, setRating] = React.useState<string>(ticket?.rating ? String(ticket.rating) : "");
  const [error, setError] = React.useState<string | null>(null);
  const done = status === "resolved" || status === "closed";

  const mutation = useMutation({
    mutationFn: () => {
      const input: TicketInput = {
        subject: subject.trim(),
        description,
        status,
        priority,
        contact_id: contact?.id ?? null,
        requester_name: contact ? "" : requesterName.trim(),
      };
      if (done) input.rating = rating ? Number(rating) : null;
      return ticket ? updateTicket(ticket.id, ticket.version, input) : createTicket(input);
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: helpdeskKeys.all });
      toast({ tone: "success", title: ticket ? "Ticket updated" : "Ticket created", description: `#${saved.number} ${saved.subject}` });
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const id = React.useId();
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{ticket ? `Ticket #${ticket.number}` : "Create Ticket"}</DialogTitle>
          <DialogDescription>{ticket ? `Opened ${formatDateTime(ticket.created_at)}` : "Log a customer's support request."}</DialogDescription>
        </DialogHeader>
        <form
          id={`${id}-form`}
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            if (!subject.trim()) {
              setError("Subject is required.");
              return;
            }
            mutation.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-subject`}>Subject</Label>
            <Input id={`${id}-subject`} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} disabled={!canEdit} required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-status`}>Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as TicketStatus)} disabled={!canEdit}>
                <SelectTrigger id={`${id}-status`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TICKET_STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {STATUS_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-priority`}>Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as TicketPriority)} disabled={!canEdit}>
                <SelectTrigger id={`${id}-priority`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TICKET_PRIORITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {PRIORITY_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-contact`}>Requester (contact)</Label>
            <RecordPicker id={`${id}-contact`} entity="contact" value={contact} onChange={setContact} disabled={!canEdit} placeholder="Search contacts…" />
          </div>
          {!contact ? (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-requester`}>Or requester name</Label>
              <Input id={`${id}-requester`} value={requesterName} onChange={(e) => setRequesterName(e.target.value)} maxLength={160} disabled={!canEdit} />
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-description`}>Description</Label>
            <Textarea id={`${id}-description`} value={description} onChange={(e) => setDescription(e.target.value)} rows={4} maxLength={10000} disabled={!canEdit} />
          </div>
          {done ? (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-rating`}>Customer rating</Label>
              <Select value={rating || "none"} onValueChange={(v) => setRating(v === "none" ? "" : v)} disabled={!canEdit}>
                <SelectTrigger id={`${id}-rating`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not rated</SelectItem>
                  {[5, 4, 3, 2, 1].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} / 5
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {canEdit ? "Cancel" : "Close"}
          </Button>
          {canEdit ? (
            <Button type="submit" form={`${id}-form`} disabled={mutation.isPending}>
              {ticket ? "Save" : "Create Ticket"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
