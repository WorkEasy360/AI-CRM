"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  Archive,
  ArrowRightLeft,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  Flag,
  Handshake,
  History,
  ListTodo,
  Mail,
  MessageCircle,
  MessageSquare,
  Pencil,
  Phone,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { daysUntil, localDay } from "@/components/crm/deals/deal-helpers";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { getTimeline } from "@/lib/api/crm";
import { CALL_OUTCOME_LABELS, ENTITY_LABELS, LIFECYCLE_LABELS, TIMELINE_FILTERS, type EntityType, type TimelineEvent } from "@/lib/api/crm-types";
import { formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { cn, formatDate, formatDateTime, humanize } from "@/lib/utils";

/* ------------------------------------------------------------------ data helpers */

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function ref(value: unknown): { id: string; name: string; kind?: string } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.name === "string" ? { id: v.id, name: v.name, kind: str(v.kind) } : null;
}

/** Owner fields arrive as a display name or as a membership ref. */
function personName(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    return str(v.display_name) || str(v.name);
  }
  return "";
}

function lifecycleLabel(value: string): string {
  return (LIFECYCLE_LABELS as Record<string, string>)[value] ?? humanize(value);
}

function lowerFirst(label: string, index: number): string {
  return index > 0 && /^[A-Z][a-z]/.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

function recipients(list: string[]): string {
  if (list.length === 0) return "";
  return list.length === 1 ? list[0]! : `${list[0]} +${list.length - 1}`;
}

function activityHref(id: string): string {
  return `/activities?open=${encodeURIComponent(id)}`;
}

/* ------------------------------------------------------------------ icons */

function Icon({ kind }: { kind: string }) {
  const cls = "size-3.5";
  switch (kind) {
    case "note":
      return <MessageSquare className={cls} aria-hidden />;
    case "deal.stage_changed":
      return <ArrowRightLeft className={cls} aria-hidden />;
    case "deal.linked":
      return <Handshake className={cls} aria-hidden />;
    case "record.created":
      return <Sparkles className={cls} aria-hidden />;
    case "record.updated":
      return <Pencil className={cls} aria-hidden />;
    case "record.archived":
      return <Archive className={cls} aria-hidden />;
    case "record.restored":
      return <RotateCcw className={cls} aria-hidden />;
    case "lifecycle.changed":
      return <Flag className={cls} aria-hidden />;
    case "activity.task":
      return <ListTodo className={cls} aria-hidden />;
    case "activity.call":
      return <Phone className={cls} aria-hidden />;
    case "activity.meeting":
      return <CalendarDays className={cls} aria-hidden />;
    case "email":
      return <Mail className={cls} aria-hidden />;
    case "whatsapp":
      return <MessageCircle className={cls} aria-hidden />;
    default:
      return <History className={cls} aria-hidden />;
  }
}

/* ------------------------------------------------------------------ sentences */

const Who = ({ name }: { name: string }) => <span className="font-medium text-fg">{name}</span>;
const Strong = ({ children }: { children: React.ReactNode }) => <span className="font-medium text-fg">{children}</span>;

function ActivityLine({ event }: { event: TimelineEvent }) {
  const d = event.data;
  const who = event.actor?.display_name ?? "Someone";
  const id = str(d.activity_id);
  const title = str(d.title);
  const status = str(d.status);
  const done = status === "completed";
  const cancelled = status === "cancelled";
  const priority = str(d.priority);
  const link = (text: string) =>
    id ? (
      <Link href={activityHref(id)} className="font-medium text-fg hover:text-primary hover:underline">
        {text}
      </Link>
    ) : (
      <Strong>{text}</Strong>
    );

  let verb: string;
  let detail: string;
  if (event.kind === "activity.call") {
    const outcome = str(d.outcome);
    const minutes = num(d.duration_minutes);
    const parts = [outcome ? ((CALL_OUTCOME_LABELS as Record<string, string>)[outcome] ?? humanize(outcome)) : "", minutes ? `${minutes} min` : ""].filter(Boolean);
    verb = cancelled ? "cancelled a call" : done ? "logged a call" : "scheduled a call";
    detail = parts.length > 0 ? parts.join(", ") : title || (done ? "Call" : formatDateTime(str(d.start_at)));
  } else if (event.kind === "activity.meeting") {
    verb = cancelled ? "cancelled a meeting" : done ? "held a meeting" : "scheduled a meeting";
    detail = [title, !done && d.start_at ? formatDateTime(str(d.start_at)) : ""].filter(Boolean).join(" · ") || "Meeting";
  } else {
    verb = cancelled ? "cancelled a task" : done ? "completed a task" : "created a task";
    detail = [title, !done && d.start_at ? `due ${formatDate(str(d.start_at))}` : ""].filter(Boolean).join(" · ") || "Task";
  }
  const description = str(d.description);
  return (
    <>
      <Who name={who} /> {verb} — {link(detail)}
      {priority === "high" || priority === "urgent" ? <span className="ml-1.5 rounded-full bg-danger-soft px-1.5 text-[10px] font-medium uppercase text-danger">{priority}</span> : null}
      {description ? <span className="mt-0.5 line-clamp-2 block text-xs text-fg-subtle">{description}</span> : null}
    </>
  );
}

function EmailLine({ event }: { event: TimelineEvent }) {
  const d = event.data;
  const [open, setOpen] = React.useState(false);
  const inbound = str(d.direction) === "inbound";
  const status = str(d.status);
  const subject = str(d.subject) || "(no subject)";
  const snippet = str(d.snippet);
  const to = recipients(strList(d.to_addresses));
  const from = str(d.from_address);
  const lead = inbound ? `Email received${from ? ` from ${from}` : ""}` : status === "failed" ? `Email to ${to || "recipient"} failed` : status === "queued" ? `Email queued to ${to || "recipient"}` : `Email sent to ${to || "recipient"}`;
  return (
    <>
      <span className={status === "failed" ? "text-danger" : undefined}>{lead}</span> — <Strong>{subject}</Strong>
      {d.ai_assisted ? <span className="ml-1.5 rounded-full border border-border px-1.5 text-[10px] font-medium uppercase tracking-wide text-fg-subtle">AI-assisted</span> : null}
      {!inbound && event.actor ? <span className="text-fg-subtle"> · by {event.actor.display_name}</span> : null}
      {snippet ? (
        <>
          <Button variant="link" size="sm" className="ml-2 h-auto text-xs" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? <ChevronUp /> : <ChevronDown />} {open ? "Hide preview" : "Show preview"}
          </Button>
          {open ? <span className="mt-1 block whitespace-pre-wrap break-words rounded-sm bg-bg-subtle px-2 py-1 text-xs text-fg">{snippet}</span> : null}
        </>
      ) : null}
    </>
  );
}

function describe(event: TimelineEvent, entity: EntityType): React.ReactNode {
  const who = event.actor?.display_name ?? "Someone";
  const d = event.data;
  const entityLabel = ENTITY_LABELS[entity].singular.toLowerCase();
  switch (event.kind) {
    case "record.created":
      return (
        <>
          <Who name={who} /> created this {entityLabel}
        </>
      );
    case "record.updated": {
      const fields = strList(d.fields).map(lowerFirst);
      const ownerFrom = personName(d.owner_from);
      const ownerTo = personName(d.owner_to);
      const ownerChanged = "owner_to" in d || "owner_from" in d;
      return (
        <>
          {ownerChanged ? (
            <>
              <Strong>Owner changed</Strong>
              {ownerFrom || ownerTo ? ` ${ownerFrom || "Unassigned"} → ${ownerTo || "Unassigned"}` : ""}
              {fields.length > 0 ? " · " : ""}
            </>
          ) : null}
          {fields.length > 0 ? (
            <>
              <Strong>{fields.join(", ")}</Strong> updated
            </>
          ) : ownerChanged ? null : (
            <>
              <Who name={who} /> updated this {entityLabel}
            </>
          )}
          {ownerChanged || fields.length > 0 ? <span className="text-fg-subtle"> · by {who}</span> : null}
        </>
      );
    }
    case "record.archived":
      return (
        <>
          <Who name={who} /> archived this {entityLabel}
        </>
      );
    case "record.restored":
      return (
        <>
          <Who name={who} /> restored this {entityLabel}
        </>
      );
    case "lifecycle.changed": {
      const from = str(d.from_stage);
      const to = str(d.to_stage);
      const source = str(d.source);
      const reason = str(d.reason);
      return (
        <>
          <Strong>Status changed</Strong> {from ? `${lifecycleLabel(from)} → ` : ""}
          {lifecycleLabel(to)}
          <span className="text-fg-subtle">
            {" "}
            · by {event.actor ? who : source && source !== "user" ? humanize(source) : "the system"}
          </span>
          {reason ? <span className="mt-0.5 block text-xs text-fg-subtle">{reason}</span> : null}
        </>
      );
    }
    case "activity.task":
    case "activity.call":
    case "activity.meeting":
      return <ActivityLine event={event} />;
    case "email":
      return <EmailLine event={event} />;
    case "whatsapp": {
      const inbound = str(d.direction) === "inbound";
      const status = str(d.status);
      const template = str(d.message_type) === "template";
      const body = str(d.body);
      return (
        <>
          <span className={status === "failed" ? "text-danger" : undefined}>{inbound ? "WhatsApp received" : status === "failed" ? "WhatsApp failed" : "WhatsApp sent"}</span>
          {template ? <span className="ml-1.5 rounded-full border border-border px-1.5 text-[10px] font-medium uppercase tracking-wide text-fg-subtle">template</span> : null}
          {!inbound && event.actor ? <span className="text-fg-subtle"> · by {who}</span> : null}
          {body ? <span className="mt-0.5 line-clamp-3 block whitespace-pre-wrap break-words text-fg">{body}</span> : null}
        </>
      );
    }
    case "note":
      return (
        <>
          <Who name={who} /> added a note
          <span className="mt-1 block whitespace-pre-wrap break-words rounded-sm bg-bg-subtle px-2 py-1 text-fg">{str(d.body)}</span>
        </>
      );
    case "deal.stage_changed": {
      const from = ref(d.from_stage);
      const to = ref(d.to_stage);
      return (
        <>
          <Who name={who} /> moved the deal {from ? <>from <Strong>{from.name}</Strong> </> : null}to <Strong>{to?.name ?? "a stage"}</Strong>
          {to?.kind === "won" ? " · Won" : to?.kind === "lost" ? " · Lost" : ""}
        </>
      );
    }
    case "deal.linked":
      return (
        <>
          Deal{" "}
          <Link href={`/deals/${encodeURIComponent(str(d.deal_id))}`} className="font-medium text-primary hover:underline">
            {str(d.name)}
          </Link>{" "}
          ({str(d.status)}, {str(d.stage)}) · {formatMoney(str(d.amount), str(d.currency))}
        </>
      );
    default:
      return <>{humanize(event.kind)}</>;
  }
}

/* ------------------------------------------------------------------ grouping */

function dayLabel(iso: string): string {
  const diff = daysUntil(iso);
  if (diff === 0) return "Today";
  if (diff === -1) return "Yesterday";
  return formatDate(iso);
}

function groupByDay(events: TimelineEvent[]): { key: string; label: string; events: TimelineEvent[] }[] {
  const sorted = [...events].sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));
  const groups: { key: string; label: string; events: TimelineEvent[] }[] = [];
  for (const event of sorted) {
    const key = localDay(event.occurred_at)?.toDateString() ?? "unknown";
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.events.push(event);
    else groups.push({ key, label: dayLabel(event.occurred_at), events: [event] });
  }
  return groups;
}

function timeOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date);
}

/* ------------------------------------------------------------------ component */

/**
 * Newest-first feed of everything that happened to a record, grouped by day, with a multi-select
 * chip row to narrow it to event families (notes, activities, emails, WhatsApp, deals, status, changes).
 */
export function Timeline({ entity, recordId, initialKinds = [], showFilters = true }: { entity: EntityType; recordId: string; initialKinds?: string[]; showFilters?: boolean }) {
  const [kinds, setKinds] = React.useState<string[]>(() => [...initialKinds].sort());
  const query = useQuery({ queryKey: crmKeys.timeline(entity, recordId, kinds), queryFn: () => getTimeline(entity, recordId, kinds), placeholderData: (prev) => prev });
  const groups = React.useMemo(() => (query.data ? groupByDay(query.data.results) : []), [query.data]);

  const toggle = (value: string) => setKinds((prev) => (prev.includes(value) ? prev.filter((k) => k !== value) : [...prev, value].sort()));

  return (
    <div>
      {showFilters ? (
        <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label="Filter timeline">
          <Chip active={kinds.length === 0} onClick={() => setKinds([])}>
            All
          </Chip>
          {TIMELINE_FILTERS.map((f) => (
            <Chip key={f.value} active={kinds.includes(f.value)} onClick={() => toggle(f.value)}>
              {f.label}
            </Chip>
          ))}
        </div>
      ) : null}
      {query.isPending ? (
        <SkeletonRows rows={4} />
      ) : query.isError ? (
        <EmptyState title="Could not load the timeline" className="py-8" />
      ) : groups.length === 0 ? (
        <EmptyState icon={<History />} title={kinds.length > 0 ? "Nothing matches these filters" : "No activity yet"} className="py-8" />
      ) : (
        <div className={cn("flex flex-col gap-4 transition-opacity", query.isPlaceholderData && "opacity-70")} aria-busy={query.isPlaceholderData || undefined}>
          {groups.map((group) => (
            <section key={group.key} aria-label={group.label}>
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">{group.label}</h3>
              <ol className="relative flex flex-col gap-3 border-l border-border pl-6">
                {group.events.map((event) => (
                  <li key={event.id} className="relative">
                    <span className="absolute -left-[29px] top-0 flex size-5 items-center justify-center rounded-full border border-border bg-surface text-fg-subtle">
                      <Icon kind={event.kind} />
                    </span>
                    <div className="text-sm text-fg-muted">{describe(event, entity)}</div>
                    <time dateTime={event.occurred_at} className="text-xs text-fg-subtle" title={formatDateTime(event.occurred_at)}>
                      {timeOf(event.occurred_at)}
                    </time>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-6 rounded-full border px-2.5 text-xs font-medium transition-colors",
        active ? "border-primary bg-primary-soft text-primary" : "border-border bg-surface text-fg-muted hover:border-border-strong hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
