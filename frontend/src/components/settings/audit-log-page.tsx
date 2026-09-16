"use client";

import * as React from "react";
import { ListChecks, Search, X } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listAuditEvents } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/problem";
import type { AuditEvent, AuditEventFilters } from "@/lib/api/types";
import { hasPermission, queryKeys, useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { formatDateTime } from "@/lib/utils";

const EMPTY: AuditEventFilters = {};

function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function actorVariant(type: AuditEvent["actor_type"]) {
  switch (type) {
    case "user":
      return "primary" as const;
    case "ai":
      return "accent" as const;
    case "integration":
      return "warning" as const;
    default:
      return "neutral" as const;
  }
}

export function AuditLogPage() {
  const { data: session } = useSession();
  const canView = hasPermission(session?.active, "audit.view");
  const [draft, setDraft] = React.useState({ action: "", actor_user: "", resource_type: "", since: "", until: "" });
  const [filters, setFilters] = React.useState<AuditEventFilters>(EMPTY);

  const key = React.useMemo(() => queryKeys.auditEvents(filters as Record<string, string | undefined>), [filters]);
  const events = useCursorList(key, (cursor) => listAuditEvents(filters, cursor), canView);

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    setFilters({
      action: draft.action.trim() || undefined,
      actor_user: draft.actor_user.trim() || undefined,
      resource_type: draft.resource_type.trim() || undefined,
      since: toIso(draft.since),
      until: toIso(draft.until),
    });
  };

  const clear = () => {
    setDraft({ action: "", actor_user: "", resource_type: "", since: "", until: "" });
    setFilters(EMPTY);
  };

  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  if (!canView) {
    return (
      <div>
        <PageHeader title="Audit log" />
        <EmptyState icon={<ListChecks />} title="No access" description="Your role does not include permission to view the audit log." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Audit log" description="Every security-relevant change in this organization, newest first." />

      <form onSubmit={apply} className="mb-4 grid gap-3 rounded-md border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-6">
        <div className="grid gap-1">
          <Label htmlFor="f-action">Action</Label>
          <Input id="f-action" placeholder="member.role_changed" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="f-actor">Actor user ID</Label>
          <Input id="f-actor" placeholder="uuid" value={draft.actor_user} onChange={(e) => setDraft({ ...draft, actor_user: e.target.value })} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="f-resource">Resource type</Label>
          <Input id="f-resource" placeholder="membership" value={draft.resource_type} onChange={(e) => setDraft({ ...draft, resource_type: e.target.value })} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="f-since">Since</Label>
          <Input id="f-since" type="datetime-local" value={draft.since} onChange={(e) => setDraft({ ...draft, since: e.target.value })} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="f-until">Until</Label>
          <Input id="f-until" type="datetime-local" value={draft.until} onChange={(e) => setDraft({ ...draft, until: e.target.value })} />
        </div>
        <div className="flex items-end gap-2">
          <Button type="submit" className="flex-1">
            <Search /> Filter
          </Button>
          {activeFilterCount > 0 ? (
            <Button type="button" variant="ghost" size="icon" onClick={clear} aria-label="Clear filters">
              <X />
            </Button>
          ) : null}
        </div>
      </form>

      {events.isPending ? (
        <SkeletonRows rows={6} />
      ) : events.isError ? (
        <EmptyState title="Could not load audit events" description={errorMessage(events.error)} action={<Button variant="secondary" onClick={() => events.refetch()}>Retry</Button>} />
      ) : events.items.length === 0 ? (
        <EmptyState icon={<ListChecks />} title="No events" description={activeFilterCount ? "Nothing matches these filters." : "Events will appear here as people make changes."} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead className="hidden md:table-cell">Resource</TableHead>
              <TableHead className="hidden lg:table-cell">IP</TableHead>
              <TableHead className="hidden xl:table-cell">Request</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.items.map((ev) => (
              <TableRow key={ev.id}>
                <TableCell className="whitespace-nowrap text-fg-muted">{formatDateTime(ev.created_at)}</TableCell>
                <TableCell>
                  <code className="font-mono text-xs">{ev.action}</code>
                  {ev.metadata && typeof ev.metadata === "object" && Object.keys(ev.metadata as object).length > 0 ? (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-primary">Details</summary>
                      <pre className="mt-1 max-w-md overflow-x-auto rounded-sm bg-bg-subtle p-2 font-mono text-[12px] text-fg-muted">
                        {JSON.stringify(ev.metadata, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <Badge variant={actorVariant(ev.actor_type)} className="w-fit">
                      {ev.actor_type}
                    </Badge>
                    <span className="truncate text-xs text-fg-muted" title={ev.actor_user_id}>
                      {ev.actor_email ?? ev.actor_user_id}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <span className="text-xs">{ev.resource_type}</span>
                  <span className="block truncate font-mono text-[12px] text-fg-subtle" title={ev.resource_id}>
                    {ev.resource_id}
                  </span>
                </TableCell>
                <TableCell className="hidden font-mono text-xs text-fg-muted lg:table-cell">{ev.ip ?? "—"}</TableCell>
                <TableCell className="hidden font-mono text-[12px] text-fg-subtle xl:table-cell">{ev.request_id}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {events.hasMore ? (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" onClick={() => events.loadMore()} loading={events.isLoadingMore}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
