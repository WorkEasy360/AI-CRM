"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, Loader2, Paperclip, Send, Smile, Ticket as TicketIcon, X } from "lucide-react";
import { relativeTime } from "@/components/activities/activity-utils";
import { CATEGORY_ICONS, CATEGORY_LABELS, PRIORITY_BADGE, PRIORITY_LABELS, STATUS_BADGE_CLASS, STATUS_LABELS } from "@/components/helpdesk/ticket-meta";
import { FilesPanel } from "@/components/crm/files-panel";
import { OwnerSelect } from "@/components/crm/owner-select";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { uploadFile } from "@/lib/api/crm";
import {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  addTicketMessage,
  deleteTicket,
  helpdeskKeys,
  listTickets,
  listTicketMessages,
  mergeTicket,
  ticketActivity,
  ticketLabel,
  updateTicket,
  type Ticket,
  type TicketInput,
  type TicketMessage,
  type TicketMessageKind,
  type TicketChannel,
} from "@/lib/api/helpdesk";
import { errorMessage } from "@/lib/api/problem";
import type { ActiveContext } from "@/lib/api/types";
import { crmKeys } from "@/lib/crm/keys";
import { hasPermission } from "@/lib/session";
import { cn, formatDateTime } from "@/lib/utils";

type Tab = "conversation" | "notes" | "activity";
/** How a message in the reply box is recorded: a plain reply, sent out, or what the customer said. */
type ReplyMode = "reply" | "email" | "whatsapp" | "customer";

const REPLY_MODES: { value: ReplyMode; label: string }[] = [
  { value: "reply", label: "Reply (log only)" },
  { value: "email", label: "Reply by email" },
  { value: "whatsapp", label: "Reply by WhatsApp" },
  { value: "customer", label: "Log customer message" },
];
const EMOJIS = ["🙂", "👍", "🙏", "✅", "⏳", "🎉", "😊", "👋"];

/** The right-hand ticket details: facts editable inline, the thread, notes and the audit trail. */
export function TicketPanel({ ticket, active, onClose, onChanged }: { ticket: Ticket; active: ActiveContext | null | undefined; onClose: () => void; onChanged: (ticket: Ticket | null) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const canUpdate = hasPermission(active, "tickets.update");
  const canDelete = hasPermission(active, "tickets.delete");
  const [tab, setTab] = React.useState<Tab>("conversation");
  const [reassigning, setReassigning] = React.useState(false);
  const [merging, setMerging] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: helpdeskKeys.all });
  const update = useMutation({
    mutationFn: (input: TicketInput) => updateTicket(ticket.id, ticket.version, input),
    onSuccess: (saved) => {
      onChanged(saved);
      refresh();
    },
    onError: (err) => toast({ tone: "error", title: "Could not update the ticket", description: errorMessage(err) }),
  });
  const remove = useMutation({
    mutationFn: () => deleteTicket(ticket.id),
    onSuccess: () => {
      toast({ tone: "success", title: `${ticketLabel(ticket)} deleted` });
      setDeleting(false);
      onChanged(null);
      refresh();
    },
    onError: (err) => toast({ tone: "error", title: "Could not delete the ticket", description: errorMessage(err) }),
  });

  const CategoryIcon = CATEGORY_ICONS[ticket.category];
  const done = ticket.status === "resolved" || ticket.status === "closed";

  return (
    <section aria-label="Ticket Details" className="flex min-h-0 flex-col rounded-2xl border border-border bg-surface shadow-sm">
      <div className="flex items-center justify-between px-4 pt-4">
        <h2 className="text-lg font-bold text-fg">Ticket Details</h2>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close ticket details">
          <X />
        </Button>
      </div>

      <div className="flex items-start gap-3 border-b border-border px-4 pb-3 pt-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand" aria-hidden>
          <TicketIcon className="size-5" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-bold text-fg">{ticketLabel(ticket)}</span>
            <Badge className={STATUS_BADGE_CLASS[ticket.status]}>{STATUS_LABELS[ticket.status]}</Badge>
            {ticket.is_overdue ? <Badge variant="danger">Overdue</Badge> : null}
          </div>
          <p className="font-semibold text-fg">{ticket.subject}</p>
          {ticket.company ? (
            <Link href={`/companies/${encodeURIComponent(ticket.company.id)}`} className="text-sm text-primary hover:underline">
              {ticket.company.name}
            </Link>
          ) : ticket.contact ? (
            <Link href={`/contacts/${encodeURIComponent(ticket.contact.id)}`} className="text-sm text-primary hover:underline">
              {ticket.contact.display_name}
            </Link>
          ) : ticket.requester ? (
            <p className="text-sm text-fg-muted">{ticket.requester}</p>
          ) : null}
        </div>
      </div>

      <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3 text-sm">
        <dt className="text-fg-muted">Category</dt>
        <dd>
          {canUpdate ? (
            <Select value={ticket.category} onValueChange={(value) => update.mutate({ category: value as Ticket["category"] })}>
              <SelectTrigger className="h-8" aria-label="Category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TICKET_CATEGORIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {CATEGORY_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <CategoryIcon className="size-4 text-fg-muted" aria-hidden /> {CATEGORY_LABELS[ticket.category]}
            </span>
          )}
        </dd>
        <dt className="text-fg-muted">Priority</dt>
        <dd>
          {canUpdate ? (
            <Select value={ticket.priority} onValueChange={(value) => update.mutate({ priority: value as Ticket["priority"] })}>
              <SelectTrigger className="h-8" aria-label="Priority">
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
          ) : (
            <Badge variant={PRIORITY_BADGE[ticket.priority]}>{PRIORITY_LABELS[ticket.priority]}</Badge>
          )}
        </dd>
        <dt className="text-fg-muted">Assigned To</dt>
        <dd className="flex min-w-0 items-center gap-2">
          <Avatar name={ticket.owner?.display_name} size="sm" />
          <span className="truncate">{ticket.owner?.display_name ?? "Unassigned"}</span>
        </dd>
        {ticket.product ? (
          <>
            <dt className="text-fg-muted">Product</dt>
            <dd className="truncate">{ticket.product.name}</dd>
          </>
        ) : null}
        <dt className="text-fg-muted">Created On</dt>
        <dd>{formatDateTime(ticket.created_at)}</dd>
        <dt className="text-fg-muted">Last Update</dt>
        <dd>{formatDateTime(ticket.updated_at)}</dd>
        {ticket.due_at && !done ? (
          <>
            <dt className="text-fg-muted">Due (SLA)</dt>
            <dd className={cn(ticket.is_overdue && "font-medium text-danger")}>{formatDateTime(ticket.due_at)}</dd>
          </>
        ) : null}
      </dl>

      <div role="tablist" aria-label="Ticket sections" className="grid grid-cols-3 gap-1 px-4 pt-3">
        {(
          [
            ["conversation", "Conversation"],
            ["notes", "Internal Notes"],
            ["activity", "Activity"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn("h-9 rounded-md text-sm font-medium transition-colors", tab === value ? "bg-brand text-brand-fg" : "text-fg hover:bg-bg-subtle")}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 px-4 py-3">
        {tab === "activity" ? <ActivityList ticket={ticket} /> : <Thread ticket={ticket} notes={tab === "notes"} canPost={canUpdate} />}
      </div>

      {canUpdate ? (
        <div className="flex gap-2 border-t border-border px-4 py-3">
          <Button
            variant="secondary"
            className="flex-1 border-brand text-brand"
            disabled={done || update.isPending}
            onClick={() => update.mutate({ status: "resolved" })}
          >
            <Check /> {done ? STATUS_LABELS[ticket.status] : "Mark as Resolved"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary">
                More <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem onSelect={() => setReassigning(true)}>Reassign</DropdownMenuItem>
              <DropdownMenuLabel className="text-xs text-fg-subtle">Change priority</DropdownMenuLabel>
              {TICKET_PRIORITIES.filter((p) => p !== ticket.priority).map((p) => (
                <DropdownMenuItem key={p} onSelect={() => update.mutate({ priority: p })} className="pl-5">
                  {PRIORITY_LABELS[p]}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setMerging(true)}>Merge into another ticket</DropdownMenuItem>
              {done ? (
                <DropdownMenuItem onSelect={() => update.mutate({ status: "open" })}>Reopen</DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => update.mutate({ status: "closed" })}>Close</DropdownMenuItem>
              )}
              {canDelete ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-danger" onSelect={() => setDeleting(true)}>
                    Delete
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ) : null}

      {reassigning ? <ReassignDialog ticket={ticket} onClose={() => setReassigning(false)} onSave={(owner) => update.mutate({ owner_id: owner }, { onSuccess: () => setReassigning(false) })} saving={update.isPending} /> : null}
      {merging ? <MergeDialog ticket={ticket} onClose={() => setMerging(false)} onMerged={(target) => { setMerging(false); onChanged(target); refresh(); }} /> : null}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${ticketLabel(ticket)}?`}
        description="The ticket and its conversation are removed for everyone. This cannot be undone."
        confirmLabel="Delete ticket"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </section>
  );
}

/** The conversation (customer and agent messages) or the internal notes, with a composer. */
function Thread({ ticket, notes, canPost }: { ticket: Ticket; notes: boolean; canPost: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const messages = useQuery({ queryKey: helpdeskKeys.messages(ticket.id), queryFn: () => listTicketMessages(ticket.id) });
  const [body, setBody] = React.useState("");
  const [mode, setMode] = React.useState<ReplyMode>("reply");
  const fileRef = React.useRef<HTMLInputElement>(null);

  const all = messages.data?.results ?? [];
  const shown = all.filter((m) => (notes ? m.kind === "note" : m.kind !== "note"));
  // The ticket's description is the customer's opening message.
  const opening: TicketMessage | null =
    !notes && ticket.description
      ? { id: "opening", kind: "customer", channel: "", author: null, author_name: ticket.requester, body: ticket.description, created_at: ticket.created_at }
      : null;
  const thread = opening ? [opening, ...shown] : shown;

  const post = useMutation({
    mutationFn: () => {
      const kind: TicketMessageKind = notes ? "note" : mode === "customer" ? "customer" : "reply";
      const send_via: TicketChannel = !notes && (mode === "email" || mode === "whatsapp") ? mode : "";
      return addTicketMessage(ticket.id, { kind, body: body.trim(), send_via });
    },
    onSuccess: () => {
      setBody("");
      queryClient.invalidateQueries({ queryKey: helpdeskKeys.all });
      if (mode === "email" || mode === "whatsapp") toast({ tone: "success", title: mode === "email" ? "Reply sent by email" : "Reply sent on WhatsApp" });
    },
    onError: (err) => toast({ tone: "error", title: "Could not post the message", description: errorMessage(err) }),
  });
  const upload = useMutation({
    mutationFn: (file: File) => uploadFile({ entity_type: "ticket", entity_id: ticket.id, file }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: crmKeys.files("ticket", ticket.id) });
      toast({ tone: "success", title: "File attached" });
    },
    onError: (err) => toast({ tone: "error", title: "Could not attach the file", description: errorMessage(err) }),
  });

  return (
    <div className="flex h-full flex-col gap-3">
      {messages.isPending ? (
        <SkeletonRows rows={3} />
      ) : messages.isError ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(messages.error)}
        </p>
      ) : thread.length === 0 ? (
        <p className="py-6 text-center text-sm text-fg-muted">{notes ? "No internal notes yet. Notes are visible to your team only." : "No messages yet."}</p>
      ) : (
        <ol className="flex max-h-[22rem] flex-col gap-3 overflow-y-auto pr-1" aria-label={notes ? "Internal notes" : "Conversation"}>
          {thread.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        </ol>
      )}

      {!notes ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs font-medium text-fg-muted">Attachments</summary>
          <div className="mt-2">
            <FilesPanel entity="ticket" recordId={ticket.id} />
          </div>
        </details>
      ) : null}

      {canPost ? (
        <form
          className="rounded-xl border border-border bg-surface p-2 shadow-sm"
          onSubmit={(event) => {
            event.preventDefault();
            if (body.trim()) post.mutate();
          }}
        >
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={notes ? "Add an internal note…" : "Type your reply…"}
            aria-label={notes ? "Internal note" : "Reply"}
            rows={2}
            maxLength={10000}
            className="resize-none border-0 shadow-none focus-visible:ring-0"
          />
          <div className="mt-1 flex items-center gap-1">
            {!notes ? (
              <Select value={mode} onValueChange={(v) => setMode(v as ReplyMode)}>
                <SelectTrigger className="h-8 w-44 text-xs" aria-label="Send as">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REPLY_MODES.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <span className="ml-auto" />
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) upload.mutate(file);
                e.target.value = "";
              }}
            />
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Attach a file" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
              {upload.isPending ? <Loader2 className="animate-spin" /> : <Paperclip />}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Insert emoji">
                  <Smile />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="grid w-40 grid-cols-4 gap-0.5 p-1">
                {EMOJIS.map((emoji) => (
                  <DropdownMenuItem key={emoji} className="justify-center text-lg" onSelect={() => setBody((b) => `${b}${emoji}`)}>
                    {emoji}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button type="submit" size="icon-sm" aria-label={notes ? "Add note" : "Send"} disabled={!body.trim() || post.isPending}>
              {post.isPending ? <Loader2 className="animate-spin" /> : <Send />}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function MessageBubble({ message }: { message: TicketMessage }) {
  const fromCustomer = message.kind === "customer";
  const name = fromCustomer ? message.author_name || "Customer" : `${message.author?.display_name ?? "Agent"}${message.kind === "reply" ? " (Support)" : ""}`;
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(message.created_at));
  return (
    <li className="flex gap-2.5">
      <Avatar name={name} size="sm" className={cn(fromCustomer && "[&>span]:bg-[#475569] [&>span]:text-white")} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-semibold text-fg">{name}</span>
          <time dateTime={message.created_at} title={formatDateTime(message.created_at)} className="text-xs text-fg-subtle">
            {time}
          </time>
          {message.channel ? <span className="text-xs text-fg-subtle">via {message.channel === "email" ? "email" : "WhatsApp"}</span> : null}
        </p>
        <p
          className={cn(
            "mt-1 whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-sm text-fg",
            message.kind === "note" ? "border border-warning/30 bg-warning-soft" : fromCustomer ? "bg-bg-subtle" : "bg-brand-soft",
          )}
        >
          {message.body}
        </p>
      </div>
    </li>
  );
}

function ActivityList({ ticket }: { ticket: Ticket }) {
  const activity = useQuery({ queryKey: helpdeskKeys.activity(ticket.id), queryFn: () => ticketActivity(ticket.id) });
  if (activity.isPending) return <SkeletonRows rows={3} />;
  if (activity.isError)
    return (
      <p role="alert" className="text-sm text-danger">
        {errorMessage(activity.error)}
      </p>
    );
  const rows = activity.data.results;
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-fg-muted">No activity yet.</p>;
  return (
    <ol className="flex max-h-[22rem] flex-col gap-2.5 overflow-y-auto" aria-label="Ticket activity">
      {rows.map((row) => (
        <li key={row.id} className="flex gap-2.5 text-sm">
          <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand" aria-hidden />
          <span className="min-w-0">
            <span className="font-medium text-fg">{row.actor}</span> <span className="text-fg-muted">{row.label}</span>
            <span className="block text-xs text-fg-subtle" title={formatDateTime(row.created_at)}>
              {relativeTime(row.created_at)}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function ReassignDialog({ ticket, onClose, onSave, saving }: { ticket: Ticket; onClose: () => void; onSave: (owner: string) => void; saving: boolean }) {
  const [owner, setOwner] = React.useState(ticket.owner?.id ?? "");
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Reassign {ticketLabel(ticket)}</DialogTitle>
          <DialogDescription>The new agent sees it in their queue straight away.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="ticket-owner">Assign to</Label>
          <OwnerSelect id="ticket-owner" value={owner} onChange={setOwner} />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => owner && onSave(owner)} disabled={!owner || owner === ticket.owner?.id} loading={saving}>
            Reassign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Merge this ticket into another one, found by its number. */
function MergeDialog({ ticket, onClose, onMerged }: { ticket: Ticket; onClose: () => void; onMerged: (target: Ticket) => void }) {
  const [number, setNumber] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const merge = useMutation({
    mutationFn: async () => {
      const found = await listTickets({ q: number.trim() });
      const target = found.results.find((t) => t.id !== ticket.id);
      if (!target) throw new Error("No other ticket has that number.");
      return mergeTicket(ticket.id, target.id);
    },
    onSuccess: onMerged,
    onError: (err) => setError(errorMessage(err)),
  });
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Merge {ticketLabel(ticket)}</DialogTitle>
          <DialogDescription>Its conversation moves to the other ticket, and this one is closed.</DialogDescription>
        </DialogHeader>
        <form
          id="merge-ticket"
          className="grid gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            if (number.trim()) merge.mutate();
          }}
        >
          <Label htmlFor="merge-into">Merge into ticket</Label>
          <Input id="merge-into" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="#TK-1044" maxLength={20} />
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="merge-ticket" disabled={!number.trim()} loading={merge.isPending}>
            Merge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
