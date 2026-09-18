import * as React from "react";
import { deliveryErrorMessage, entityLabel, eventLabel } from "@/components/settings/integrations/labels";
import { DeliveryStatusBadge } from "@/components/settings/integrations/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Delivery } from "@/lib/api/integrations";
import { formatDateTime } from "@/lib/utils";

/** Recent outbound deliveries (connection pushes or webhook events). */
export function DeliveriesTable({ deliveries }: { deliveries: Delivery[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Event</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Attempts</TableHead>
          <TableHead className="hidden md:table-cell">Response</TableHead>
          <TableHead>Time</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {deliveries.map((d) => {
          const retrying = d.status === "pending" && d.attempts > 0;
          const problem = d.status === "succeeded" || d.status === "skipped" ? "" : deliveryErrorMessage(d.error_code);
          return (
            <TableRow key={d.id}>
              <TableCell>
                <div className="font-medium">{eventLabel(d.event_type)}</div>
                {d.entity_type ? <div className="text-xs text-fg-subtle">{entityLabel(d.entity_type)}</div> : null}
              </TableCell>
              <TableCell>
                <DeliveryStatusBadge status={d.status} retrying={retrying} />
                {problem ? <p className="mt-1 max-w-xs text-xs text-danger">{problem}</p> : null}
                {retrying && d.next_attempt_at ? <p className="mt-1 text-xs text-fg-subtle">Next attempt {formatDateTime(d.next_attempt_at)}</p> : null}
              </TableCell>
              <TableCell className="text-right tabular-nums">{d.attempts}</TableCell>
              <TableCell className="hidden text-fg-muted md:table-cell">{d.response_status ? `HTTP ${d.response_status}` : "—"}</TableCell>
              <TableCell className="whitespace-nowrap text-fg-muted">{formatDateTime(d.delivered_at ?? d.created_at)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
