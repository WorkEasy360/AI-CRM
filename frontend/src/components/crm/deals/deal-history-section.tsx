"use client";

import { useQuery } from "@tanstack/react-query";
import { StageBadge } from "@/components/crm/pipeline/deals-list";
import { Section } from "@/components/crm/record-page";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dealHistory } from "@/lib/api/crm";
import { errorMessage } from "@/lib/api/problem";
import { formatDuration } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { formatDateTime } from "@/lib/utils";

/** Stage moves of a deal, newest first, with the time spent in the previous stage. */
export function DealHistorySection({ dealId }: { dealId: string }) {
  const history = useQuery({ queryKey: crmKeys.dealHistory(dealId), queryFn: () => dealHistory(dealId) });
  const items = history.data?.results ?? [];
  return (
    <Section title="Stage history">
      {history.isPending ? (
        <SkeletonRows rows={3} />
      ) : history.isError ? (
        <p className="text-sm text-danger">{errorMessage(history.error)}</p>
      ) : items.length === 0 ? (
        <EmptyState title="No stage changes yet" className="py-8" />
      ) : (
        <Table>
          <caption className="sr-only">Stage history, newest first</caption>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>From</TableHead>
              <TableHead>To</TableHead>
              <TableHead>By</TableHead>
              <TableHead className="text-right">Time in previous stage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="whitespace-nowrap text-fg-muted">{formatDateTime(entry.changed_at)}</TableCell>
                <TableCell>{entry.from_stage ? <StageBadge name={entry.from_stage.name} colorToken={entry.from_stage.color_token} /> : <span className="text-fg-subtle">—</span>}</TableCell>
                <TableCell>
                  <StageBadge name={entry.to_stage.name} colorToken={entry.to_stage.color_token} />
                </TableCell>
                <TableCell>{entry.changed_by?.display_name ?? (entry.source && entry.source !== "user" ? entry.source : "—")}</TableCell>
                <TableCell className="text-right tabular-nums">{formatDuration(entry.duration_seconds) || "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}
