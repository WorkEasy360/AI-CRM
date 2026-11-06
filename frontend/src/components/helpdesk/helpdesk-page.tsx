"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, Building2, CheckCircle2, Clock3, Headset, List, MoreVertical, Plus, Search, SlidersHorizontal, Ticket as TicketIcon, Timer } from "lucide-react";
import { relativeTime } from "@/components/activities/activity-utils";
import { RecordPicker } from "@/components/activities/pickers";
import { KpiTile, percentChange, type KpiChange } from "@/components/dashboard/stat-tile";
import { CATEGORY_ICONS, CATEGORY_LABELS, PRIORITY_BADGE, PRIORITY_LABELS, STATUS_BADGE_CLASS, STATUS_LABELS } from "@/components/helpdesk/ticket-meta";
import { TicketPanel } from "@/components/helpdesk/ticket-panel";
import { PageHeader } from "@/components/page-header";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { getContact, listProducts } from "@/lib/api/crm";
import type { NamedRef } from "@/lib/api/crm-types";
import { listMembers } from "@/lib/api/endpoints";
import {
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  createTicket,
  formatDurationShort,
  getTicket,
  getTicketSla,
  helpdeskKeys,
  listTickets,
  ticketLabel,
  ticketSummary,
  updateTicket,
  updateTicketSla,
  type Ticket,
  type TicketCategory,
  type TicketPriority,
  type TicketSummary,
} from "@/lib/api/helpdesk";
import { errorMessage } from "@/lib/api/problem";
import { useListParams } from "@/lib/crm/use-list-params";
import { hasPermission, queryKeys, useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { cn } from "@/lib/utils";

// Re-exported for existing imports.
export { PRIORITY_LABELS, STATUS_LABELS } from "@/components/helpdesk/ticket-meta";

const ALL = "__all__";
const URL_KEYS = ["tab", "q", "priority", "category", "owner", "product", "open", "new", "contact"] as const;

type TabKey = "all" | "open" | "in_progress" | "resolved" | "overdue";
const TABS: { key: TabKey; label: string; count: (s: TicketSummary) => number }[] = [
  { key: "all", label: "All Tickets", count: (s) => s.total },
  { key: "open", label: "Open", count: (s) => s.open },
  { key: "in_progress", label: "In Progress", count: (s) => s.in_progress },
  { key: "resolved", label: "Resolved", count: (s) => s.resolved },
  { key: "overdue", label: "Overdue", count: (s) => s.overdue },
];

/** The ticket list filters a tab maps to. Resolved covers closed tickets too (the header counts them together). */
function tabParams(tab: TabKey): Record<string, string | undefined> {
  if (tab === "overdue") return { overdue: "1" };
  if (tab === "all") return {};
  return { status: tab === "resolved" ? "resolved,closed" : tab };
}

export function HelpdeskPage() {
  const { data: session } = useSession();
  const active = session?.active;
  const queryClient = useQueryClient();
  const canView = hasPermission(active, "tickets.view");
  const canCreate = hasPermission(active, "tickets.create");
  const canUpdate = hasPermission(active, "tickets.update");
  const { params, setParam, setParams } = useListParams(URL_KEYS);
  const tab = (TABS.some((t) => t.key === params.tab) ? params.tab : "all") as TabKey;
  const [search, setSearch] = React.useState(params.q ?? "");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [slaOpen, setSlaOpen] = React.useState(false);
  const creating = params.new === "1";
  const wide = useWide();

  React.useEffect(() => {
    const id = window.setTimeout(() => {
      if ((params.q ?? "") !== search.trim()) setParam("q", search.trim() || undefined);
    }, 300);
    return () => window.clearTimeout(id);
  }, [search, params.q, setParam]);

  const filters = {
    q: params.q,
    priority: params.priority,
    category: params.category,
    owner: params.owner,
    product: params.product,
    ...tabParams(tab),
  };
  const tickets = useCursorList(helpdeskKeys.list(filters), (cursor) => listTickets(filters, cursor), canView, {
    recordKey: (t: Ticket) => helpdeskKeys.detail(t.id),
  });
  const summary = useQuery({ queryKey: helpdeskKeys.summary, queryFn: ticketSummary, enabled: canView, staleTime: 30_000 });
  const openId = params.open;
  const opened = useQuery({ queryKey: helpdeskKeys.detail(openId ?? ""), queryFn: () => getTicket(openId ?? ""), enabled: canView && Boolean(openId) });

  const bulkResolve = useMutation({
    mutationFn: async (rows: Ticket[]) => {
      for (const row of rows) await updateTicket(row.id, row.version, { status: "resolved" });
      return rows.length;
    },
    onSettled: () => {
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: helpdeskKeys.all });
    },
  });

  if (!session) return null;
  if (!canView) {
    return <EmptyState icon={<Headset />} title="Helpdesk is not part of your role" description="Ask a workspace administrator to give your role access to tickets." />;
  }
  const s = summary.data;
  const rows = tickets.items;
  const filtered = Boolean(params.q || params.priority || params.category || params.owner || params.product || tab !== "all");
  const versus = s ? `vs previous ${s.previous.days} days` : "";
  const resolutionChange: KpiChange | null = s ? withLowerIsBetter(percentChange(s.avg_resolution_seconds, s.previous.avg_resolution_seconds, versus)) : null;
  const panelTicket = openId ? (opened.data ?? rows.find((r) => r.id === openId) ?? null) : null;
  const closePanel = () => setParam("open", undefined);
  const onChanged = (ticket: Ticket | null) => {
    if (ticket) queryClient.setQueryData(helpdeskKeys.detail(ticket.id), ticket);
    if (!ticket || ticket.id !== openId) setParams({ open: ticket?.id });
  };
  const selectedRows = rows.filter((r) => selected.has(r.id));

  const panel = panelTicket ? <TicketPanel key={panelTicket.id} ticket={panelTicket} active={active} onClose={closePanel} onChanged={onChanged} /> : null;

  return (
    <div className="mx-auto max-w-[96rem]">
      <PageHeader icon={Headset} title="Helpdesk" description="Manage customer support tickets, track issues and resolve them faster." />

      <div className={cn("grid gap-4", panel && wide && "grid-cols-[minmax(0,1fr)_25rem]")}>
        <div className="min-w-0">
          <section aria-label="Ticket summary" className={cn("grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3", panel && wide ? "2xl:grid-cols-6" : "xl:grid-cols-6")}>
            <KpiTile tone="green" icon={<TicketIcon />} label="Total Tickets" value={s?.total.toLocaleString()} change={s ? percentChange(s.created, s.previous.created, versus) : null} changeNote="new" />
            <KpiTile tone="blue" icon={<Headset />} label="Open" value={s?.open.toLocaleString()} sub="Waiting for a reply" href="/helpdesk?tab=open" />
            <KpiTile tone="orange" icon={<Clock3 />} label="In Progress" value={s?.in_progress.toLocaleString()} sub="Being worked on" href="/helpdesk?tab=in_progress" />
            <KpiTile tone="green" icon={<CheckCircle2 />} label="Resolved" value={s?.resolved.toLocaleString()} sub="Resolved or closed" href="/helpdesk?tab=resolved" />
            <KpiTile tone="red" icon={<AlarmClock />} label="Overdue" value={s?.overdue.toLocaleString()} sub="Past their SLA" href="/helpdesk?tab=overdue" />
            <KpiTile tone="purple" icon={<Timer />} label="Avg. Resolution" value={s ? formatDurationShort(s.avg_resolution_seconds) : undefined} sub="Last 30 days" change={resolutionChange} changeNote="" />
          </section>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div role="tablist" aria-label="Ticket views" className="flex flex-wrap items-center gap-1 rounded-xl border border-border bg-surface p-1 shadow-sm">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => {
                    setSelected(new Set());
                    setParam("tab", t.key === "all" ? undefined : t.key);
                  }}
                  className={cn(
                    "inline-flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-sm font-medium transition-colors",
                    tab === t.key ? "bg-brand text-brand-fg shadow-sm" : "text-fg hover:bg-bg-subtle",
                  )}
                >
                  {t.key === "all" ? <List className="size-4" aria-hidden /> : null}
                  {t.label}{" "}
                  {s ? <span className={cn("tabular-nums", tab === t.key ? "text-brand-fg/90" : "text-fg-muted")}>({t.count(s).toLocaleString()})</span> : null}
                </button>
              ))}
            </div>
            {canCreate ? (
              <Button className="ml-auto" onClick={() => setParam("new", "1")}>
                <Plus /> Create Ticket
              </Button>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-56 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tickets by ID, subject, customer…" aria-label="Search tickets" className="h-9 pl-8" maxLength={200} />
            </div>
            <FilterSelect label="All Priorities" value={params.priority} onChange={(v) => setParam("priority", v)} options={TICKET_PRIORITIES.map((p) => [p, PRIORITY_LABELS[p]])} />
            <FilterSelect label="All Categories" value={params.category} onChange={(v) => setParam("category", v)} options={TICKET_CATEGORIES.map((c) => [c, CATEGORY_LABELS[c]])} />
            <AgentFilter value={params.owner} onChange={(v) => setParam("owner", v)} />
            {hasPermission(active, "products.view") ? <ProductFilter value={params.product} onChange={(v) => setParam("product", v)} /> : null}
            <Button size="icon" aria-label="List view" aria-pressed className="pointer-events-none">
              <List />
            </Button>
            <Button variant="secondary" size="icon" aria-label="SLA settings" onClick={() => setSlaOpen(true)}>
              <SlidersHorizontal />
            </Button>
          </div>

          {selectedRows.length > 0 && canUpdate ? (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary-soft px-3 py-2 text-sm">
              <span className="font-medium text-fg">{selectedRows.length} selected</span>
              <Button size="sm" variant="secondary" loading={bulkResolve.isPending} onClick={() => bulkResolve.mutate(selectedRows)}>
                <CheckCircle2 /> Mark as Resolved
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          ) : null}

          <section aria-label="Tickets" className="mt-3 rounded-2xl border border-border bg-surface shadow-sm">
            {tickets.isError ? (
              <EmptyState title="Could not load tickets" description={errorMessage(tickets.error)} action={<Button variant="secondary" onClick={() => queryClient.invalidateQueries({ queryKey: helpdeskKeys.all })}>Retry</Button>} />
            ) : tickets.isPending ? (
              <div className="p-3">
                <SkeletonRows rows={6} />
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                icon={<Headset />}
                title={filtered ? "No tickets match these filters" : "No tickets yet"}
                description={canCreate && !filtered ? "Log a customer's request to start tracking it." : undefined}
                action={canCreate && !filtered ? <Button size="sm" onClick={() => setParam("new", "1")}>Create Ticket</Button> : undefined}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        aria-label="Select all tickets"
                        className="size-4 accent-[var(--kl-brand)]"
                        checked={rows.length > 0 && selected.size === rows.length}
                        onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
                      />
                    </TableHead>
                    <TableHead className="w-24">Ticket ID</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead className="hidden lg:table-cell">Contact / Company</TableHead>
                    <TableHead className="hidden md:table-cell">Category</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">Assigned To</TableHead>
                    <TableHead className="hidden sm:table-cell">Updated</TableHead>
                    <TableHead className="w-10">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((ticket) => {
                    const CategoryIcon = CATEGORY_ICONS[ticket.category];
                    const open = () => setParam("open", ticket.id);
                    return (
                      <TableRow key={ticket.id} data-state={ticket.id === openId ? "selected" : undefined} className={cn(ticket.id === openId && "bg-primary-soft/50")}>
                        <TableCell>
                          <input
                            type="checkbox"
                            aria-label={`Select ${ticketLabel(ticket)}`}
                            className="size-4 accent-[var(--kl-brand)]"
                            checked={selected.has(ticket.id)}
                            onChange={(e) =>
                              setSelected((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(ticket.id);
                                else next.delete(ticket.id);
                                return next;
                              })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <button type="button" onClick={open} className="font-semibold tabular-nums text-primary hover:underline">
                            {ticketLabel(ticket)}
                          </button>
                        </TableCell>
                        <TableCell>
                          <button type="button" onClick={open} className="text-left font-medium text-fg hover:text-primary">
                            {ticket.subject}
                          </button>
                          {ticket.is_overdue ? <span className="ml-2 text-xs font-medium text-danger">Overdue</span> : null}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          <span className="inline-flex items-center gap-1.5 text-primary">
                            <Building2 className="size-4 shrink-0" aria-hidden />
                            <span className="truncate">{ticket.company?.name ?? (ticket.requester || "—")}</span>
                          </span>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <span className="inline-flex items-center gap-1.5 text-fg">
                            <CategoryIcon className="size-4 text-fg-muted" aria-hidden />
                            {CATEGORY_LABELS[ticket.category]}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant={PRIORITY_BADGE[ticket.priority]}>{PRIORITY_LABELS[ticket.priority]}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge className={STATUS_BADGE_CLASS[ticket.status]}>{STATUS_LABELS[ticket.status]}</Badge>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <span className="inline-flex items-center gap-2">
                            <Avatar name={ticket.owner?.display_name} size="sm" />
                            <span className="truncate">{ticket.owner?.display_name ?? "Unassigned"}</span>
                          </span>
                        </TableCell>
                        <TableCell className="hidden whitespace-nowrap text-fg-muted sm:table-cell">{relativeTime(ticket.updated_at)}</TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${ticketLabel(ticket)}`}>
                                <MoreVertical />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onSelect={open}>View</DropdownMenuItem>
                              {canUpdate && ticket.status !== "resolved" && ticket.status !== "closed" ? (
                                <DropdownMenuItem onSelect={() => bulkResolve.mutate([ticket])}>Mark as Resolved</DropdownMenuItem>
                              ) : null}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
            {rows.length > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-sm text-fg-muted">
                <span>
                  Showing 1–{rows.length.toLocaleString()}
                  {s && !filtered ? ` of ${s.total.toLocaleString()} tickets` : " tickets"}
                </span>
                {tickets.hasMore ? (
                  <Button variant="secondary" size="sm" onClick={() => tickets.loadMore()} loading={tickets.isLoadingMore}>
                    Load more
                  </Button>
                ) : null}
              </div>
            ) : null}
          </section>
        </div>

        {panel && wide ? <div className="min-w-0">{panel}</div> : null}
      </div>

      {/* Below the wide layout the details open as a slide-over instead of a column. */}
      <NarrowPanel open={Boolean(panel) && !wide} onClose={closePanel}>
        {panel}
      </NarrowPanel>

      {creating && canCreate ? (
        <CreateTicketDialog
          defaultContactId={params.contact}
          onClose={() => setParams({ new: undefined, contact: undefined })}
          onCreated={(ticket) => setParams({ new: undefined, contact: undefined, open: ticket.id })}
        />
      ) : null}
      {slaOpen ? <SlaDialog canEdit={hasPermission(active, "org.update")} onClose={() => setSlaOpen(false)} /> : null}
    </div>
  );
}

function withLowerIsBetter(change: KpiChange | null): KpiChange | null {
  return change ? { ...change, lowerIsBetter: true } : null;
}

/** True at the xl breakpoint, where the ticket details sit beside the table. */
function useWide(): boolean {
  const [wide, setWide] = React.useState(false);
  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(min-width: 80rem)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

function NarrowPanel({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <SheetContent side="right" className="w-full max-w-md overflow-y-auto p-2">
        <SheetTitle className="sr-only">Ticket details</SheetTitle>
        <SheetDescription className="sr-only">The selected ticket</SheetDescription>
        {children}
      </SheetContent>
    </Sheet>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string | undefined; onChange: (value: string | undefined) => void; options: [string, string][] }) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
      <SelectTrigger className="h-9 w-40" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{label}</SelectItem>
        {options.map(([v, text]) => (
          <SelectItem key={v} value={v}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function AgentFilter({ value, onChange }: { value: string | undefined; onChange: (value: string | undefined) => void }) {
  const members = useCursorList(queryKeys.members, listMembers);
  const options = members.items.filter((m) => m.status === "active").map((m) => [m.id, m.user.display_name || m.user.email] as [string, string]);
  if (members.isError) return null;
  return <FilterSelect label="All Agents" value={value} onChange={onChange} options={[["me", "Me"], ...options]} />;
}

function ProductFilter({ value, onChange }: { value: string | undefined; onChange: (value: string | undefined) => void }) {
  const products = useQuery({ queryKey: ["helpdesk", "products"], queryFn: () => listProducts({ limit: "100", sort: "name" }), staleTime: 60_000 });
  if (products.isError) return null;
  return <FilterSelect label="All Products" value={value} onChange={onChange} options={(products.data?.results ?? []).map((p) => [p.id, p.name])} />;
}

/** Log a customer's request. Everything else (assignee, thread) is handled in the details panel. */
function CreateTicketDialog({ defaultContactId, onClose, onCreated }: { defaultContactId?: string; onClose: () => void; onCreated: (ticket: Ticket) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [subject, setSubject] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [priority, setPriority] = React.useState<TicketPriority>("medium");
  const [category, setCategory] = React.useState<TicketCategory>("support");
  const [contact, setContact] = React.useState<NamedRef | null>(null);
  const [requesterName, setRequesterName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  // Opened from a contact ("+ Create → Ticket" there): start with that contact as the requester.
  const preset = useQuery({ queryKey: ["helpdesk", "preset-contact", defaultContactId], queryFn: () => getContact(defaultContactId ?? ""), enabled: Boolean(defaultContactId) });
  React.useEffect(() => {
    if (preset.data) setContact((current) => current ?? { id: preset.data.id, name: preset.data.display_name });
  }, [preset.data]);

  const mutation = useMutation({
    mutationFn: () =>
      createTicket({ subject: subject.trim(), description, priority, category, contact_id: contact?.id ?? null, requester_name: contact ? "" : requesterName.trim() }),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: helpdeskKeys.all });
      toast({ tone: "success", title: "Ticket created", description: `${ticketLabel(saved)} ${saved.subject}` });
      onCreated(saved);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const id = React.useId();
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Ticket</DialogTitle>
          <DialogDescription>Log a customer&apos;s support request.</DialogDescription>
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
            <Input id={`${id}-subject`} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-category`}>Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as TicketCategory)}>
                <SelectTrigger id={`${id}-category`}>
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
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-priority`}>Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as TicketPriority)}>
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
            <RecordPicker id={`${id}-contact`} entity="contact" value={contact} onChange={setContact} placeholder="Search contacts…" />
          </div>
          {!contact ? (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-requester`}>Or requester name</Label>
              <Input id={`${id}-requester`} value={requesterName} onChange={(e) => setRequesterName(e.target.value)} maxLength={160} />
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-description`}>Description</Label>
            <Textarea id={`${id}-description`} value={description} onChange={(e) => setDescription(e.target.value)} rows={4} maxLength={10000} />
          </div>
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
          <Button type="submit" form={`${id}-form`} loading={mutation.isPending}>
            Create Ticket
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Hours to resolution per priority. Everyone with the helpdesk sees them; admins change them. */
function SlaDialog({ canEdit, onClose }: { canEdit: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const sla = useQuery({ queryKey: helpdeskKeys.sla, queryFn: getTicketSla });
  const [draft, setDraft] = React.useState<Partial<Record<TicketPriority, string>>>({});
  const save = useMutation({
    mutationFn: () => updateTicketSla(Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, Number(v)]))),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: helpdeskKeys.all });
      toast({ tone: "success", title: "SLA updated" });
      onClose();
    },
    onError: (err) => toast({ tone: "error", title: "Could not update the SLA", description: errorMessage(err) }),
  });
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Resolution SLA</DialogTitle>
          <DialogDescription>Hours from creation before an open ticket counts as overdue.</DialogDescription>
        </DialogHeader>
        {sla.isPending ? (
          <SkeletonRows rows={4} />
        ) : sla.isError ? (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(sla.error)}
          </p>
        ) : (
          <div className="grid gap-2">
            {(["urgent", "high", "medium", "low"] as const).map((p) => (
              <div key={p} className="grid grid-cols-[6rem_1fr] items-center gap-3">
                <Label htmlFor={`sla-${p}`}>{PRIORITY_LABELS[p]}</Label>
                <Input
                  id={`sla-${p}`}
                  type="number"
                  min={1}
                  max={2160}
                  disabled={!canEdit}
                  value={draft[p] ?? String(sla.data[p])}
                  onChange={(e) => setDraft((d) => ({ ...d, [p]: e.target.value }))}
                  aria-describedby={`sla-${p}-unit`}
                />
                <span id={`sla-${p}-unit`} className="sr-only">
                  hours
                </span>
              </div>
            ))}
            {!canEdit ? <p className="text-xs text-fg-muted">Only workspace administrators can change the SLA.</p> : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {canEdit ? "Cancel" : "Close"}
          </Button>
          {canEdit ? (
            <Button onClick={() => save.mutate()} disabled={Object.keys(draft).length === 0} loading={save.isPending}>
              Save
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
