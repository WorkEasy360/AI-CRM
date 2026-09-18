"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { entityLabel, fieldLabel, formatExternalValue, recordHref } from "@/components/settings/integrations/labels";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import {
  integrationKeys,
  listConnectionConflicts,
  resolveConflict,
  type ConflictResolution,
  type ConnectionDetail,
  type IntegrationOptions,
} from "@/lib/api/integrations";
import { errorMessage } from "@/lib/api/problem";
import { formatDateTime } from "@/lib/utils";

export function ConflictsPanel({ connection, options, canManage }: { connection: ConnectionDetail; options?: IntegrationOptions; canManage: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const conflicts = useQuery({ queryKey: integrationKeys.conflicts(connection.id), queryFn: () => listConnectionConflicts(connection.id) });

  const resolve = useMutation({
    mutationFn: ({ conflictId, resolution }: { conflictId: string; resolution: ConflictResolution }) => resolveConflict(connection.id, conflictId, resolution),
    onSuccess: async (_conflict, { resolution }) => {
      toast({ tone: "success", title: resolution === "keep_crm" ? "Kept the CRM values" : "Applied the external values" });
      await queryClient.invalidateQueries({ queryKey: integrationKeys.connection(connection.id) });
    },
    onError: (err) => toast({ tone: "error", title: "Could not resolve the conflict", description: errorMessage(err) }),
  });

  const labelFor = (entityType: string) => options?.entities.find((e) => e.key === entityType)?.label ?? entityLabel(entityType);

  if (conflicts.isPending) return <SkeletonRows rows={3} />;
  if (conflicts.isError) {
    return (
      <EmptyState
        title="Could not load conflicts"
        description={errorMessage(conflicts.error)}
        action={
          <Button variant="secondary" onClick={() => conflicts.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }
  const rows = conflicts.data.results;
  if (rows.length === 0) {
    return <EmptyState icon={<CheckCircle2 />} title="No open conflicts" description="When a record changes in both Keel and the external system, it waits here for your decision." />;
  }

  return (
    <div className="grid gap-3">
      <p className="text-sm text-fg-muted">These records changed in both systems. Choose which values to keep; the other system is updated on the next sync.</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Record</TableHead>
            <TableHead>Different fields (external value)</TableHead>
            <TableHead className="hidden md:table-cell">Detected</TableHead>
            {canManage ? (
              <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((c) => {
            const href = recordHref(c.entity_type, c.crm_record_id);
            const pending = resolve.isPending && resolve.variables?.conflictId === c.id;
            return (
              <TableRow key={c.id}>
                <TableCell className="align-top">
                  <div className="font-medium">
                    {href ? (
                      <Link href={href} className="hover:text-primary hover:underline">
                        {labelFor(c.entity_type)} record
                      </Link>
                    ) : (
                      `${labelFor(c.entity_type)} record`
                    )}
                  </div>
                  <div className="font-mono text-xs text-fg-subtle">CRM {c.crm_record_id}</div>
                  {c.external_record_id ? <div className="font-mono text-xs text-fg-subtle">External {c.external_record_id}</div> : null}
                </TableCell>
                <TableCell className="align-top">
                  <dl className="grid gap-1">
                    {c.fields.map((field) => (
                      <div key={field} className="flex flex-wrap gap-x-2 text-sm">
                        <dt className="text-fg-muted">{fieldLabel(field)}:</dt>
                        <dd className="break-words">{formatExternalValue(c.external_values[field])}</dd>
                      </div>
                    ))}
                  </dl>
                </TableCell>
                <TableCell className="hidden whitespace-nowrap align-top text-fg-muted md:table-cell">{formatDateTime(c.created_at)}</TableCell>
                {canManage ? (
                  <TableCell className="align-top">
                    <div className="flex flex-wrap justify-end gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={pending}
                        loading={pending && resolve.variables?.resolution === "keep_crm"}
                        onClick={() => resolve.mutate({ conflictId: c.id, resolution: "keep_crm" })}
                      >
                        Keep CRM
                      </Button>
                      <Button
                        size="sm"
                        disabled={pending}
                        loading={pending && resolve.variables?.resolution === "apply_external"}
                        onClick={() => resolve.mutate({ conflictId: c.id, resolution: "apply_external" })}
                      >
                        Apply external
                      </Button>
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
