"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { ArrowRightLeft, Handshake, History, MessageSquare, Sparkles } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { getTimeline } from "@/lib/api/crm";
import type { EntityType, TimelineEvent } from "@/lib/api/crm-types";
import { formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { formatDateTime } from "@/lib/utils";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function ref(value: unknown): { id: string; name: string; kind?: string } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && typeof v.name === "string" ? { id: v.id, name: v.name, kind: str(v.kind) } : null;
}

function Icon({ kind }: { kind: string }) {
  const cls = "size-4";
  switch (kind) {
    case "note":
      return <MessageSquare className={cls} aria-hidden />;
    case "deal.stage_changed":
      return <ArrowRightLeft className={cls} aria-hidden />;
    case "deal.linked":
      return <Handshake className={cls} aria-hidden />;
    case "record.created":
      return <Sparkles className={cls} aria-hidden />;
    default:
      return <History className={cls} aria-hidden />;
  }
}

function describe(event: TimelineEvent): React.ReactNode {
  const who = event.actor?.display_name ?? "Someone";
  const d = event.data;
  switch (event.kind) {
    case "record.created":
      return <span><span className="font-medium">{who}</span> created this record</span>;
    case "note":
      return (
        <span>
          <span className="font-medium">{who}</span> added a note
          <span className="mt-1 block whitespace-pre-wrap break-words rounded-sm bg-bg-subtle px-2 py-1 text-fg">{str(d.body)}</span>
        </span>
      );
    case "deal.stage_changed": {
      const from = ref(d.from_stage);
      const to = ref(d.to_stage);
      return (
        <span>
          <span className="font-medium">{who}</span> moved the deal {from ? <>from <span className="font-medium">{from.name}</span> </> : null}to{" "}
          <span className="font-medium">{to?.name ?? "a stage"}</span>
          {to?.kind === "won" ? " · Won" : to?.kind === "lost" ? " · Lost" : ""}
        </span>
      );
    }
    case "deal.linked":
      return (
        <span>
          Deal{" "}
          <Link href={`/deals/${encodeURIComponent(str(d.deal_id))}`} className="font-medium text-primary hover:underline">
            {str(d.name)}
          </Link>{" "}
          ({str(d.status)}, {str(d.stage)}) · {formatMoney(str(d.amount), str(d.currency))}
        </span>
      );
    default:
      return <span>{event.kind}</span>;
  }
}

/** Newest-first feed of what happened to a record (notes, stage moves, linked deals, creation). */
export function Timeline({ entity, recordId }: { entity: EntityType; recordId: string }) {
  const query = useQuery({ queryKey: crmKeys.timeline(entity, recordId), queryFn: () => getTimeline(entity, recordId) });
  if (query.isPending) return <SkeletonRows rows={4} />;
  if (query.isError) return <EmptyState title="Could not load the timeline" />;
  const events = query.data.results;
  if (events.length === 0) return <EmptyState icon={<History />} title="No activity yet" className="py-8" />;
  return (
    <ol className="relative flex flex-col gap-4 border-l border-border pl-6">
      {events.map((event) => (
        <li key={event.id} className="relative">
          <span className="absolute -left-[31px] top-0.5 flex size-6 items-center justify-center rounded-full border border-border bg-surface text-fg-subtle">
            <Icon kind={event.kind} />
          </span>
          <div className="text-sm text-fg-muted">{describe(event)}</div>
          <time dateTime={event.occurred_at} className="text-xs text-fg-subtle">
            {formatDateTime(event.occurred_at)}
          </time>
        </li>
      ))}
    </ol>
  );
}
