"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCheck, UserRound, X } from "lucide-react";
import { useInvalidateActivities } from "@/components/activities/activity-utils";
import { OwnerSelect } from "@/components/crm/owner-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { bulkActivities } from "@/lib/api/crm";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { scopeOf } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";

type BulkInput = Parameters<typeof bulkActivities>[0];

function bulkError(err: unknown): string {
  if (isApiError(err) && err.type === "bulk_out_of_scope") return "Some selected activities are not yours to change. Nothing was updated.";
  return errorMessage(err);
}

/**
 * Action bar for selected activities: Mark complete, and Reassign when the actor may assign
 * activities to others (`activities.update` with the `all` scope). The parent renders it only for
 * actors holding `activities.bulk_update`; the API re-checks every id.
 */
export function ActivityBulkBar({ selected, loaded, onSelectAll, onClear }: { selected: Set<string>; loaded: number; onSelectAll: () => void; onClear: () => void }) {
  const { data: session } = useSession();
  const reassignAllowed = scopeOf(session?.active, "activities.update") === "all";
  const invalidate = useInvalidateActivities();
  const { toast } = useToast();
  const [reassignOpen, setReassignOpen] = React.useState(false);
  const [ownerId, setOwnerId] = React.useState("");

  const mutation = useMutation({
    mutationFn: (input: Omit<BulkInput, "ids">) => bulkActivities({ ids: [...selected], ...input }),
    onSuccess: async (result) => {
      await invalidate();
      toast({
        tone: "success",
        title: `${result.affected.toLocaleString()} of ${result.requested.toLocaleString()} updated`,
        description: result.affected < result.requested ? "The rest were already done or already had that owner." : undefined,
      });
      setReassignOpen(false);
      setOwnerId("");
      onClear();
    },
    onError: (err) => toast({ tone: "error", title: "Bulk action failed", description: bulkError(err) }),
  });

  const count = selected.size;
  const label = `${count.toLocaleString()} ${count === 1 ? "activity" : "activities"}`;

  return (
    <div role="region" aria-label="Bulk actions" className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary-soft px-3 py-2 text-sm">
      <span className="font-medium text-primary">{count > 0 ? `${label} selected` : "Select activities"}</span>
      {count < loaded ? (
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onSelectAll}>
          Select all {loaded.toLocaleString()}
        </Button>
      ) : null}
      {count > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          <Button variant="secondary" size="sm" onClick={() => mutation.mutate({ action: "complete" })} loading={mutation.isPending && mutation.variables?.action === "complete"}>
            <CheckCheck /> Mark complete
          </Button>
          {reassignAllowed ? (
            <Button variant="secondary" size="sm" onClick={() => setReassignOpen(true)}>
              <UserRound /> Reassign
            </Button>
          ) : null}
        </div>
      ) : null}
      <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Stop selecting" onClick={onClear}>
        <X />
      </Button>

      <Dialog open={reassignOpen} onOpenChange={setReassignOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reassign {label}</DialogTitle>
            <DialogDescription>Choose the member who should own the selected activities.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="activity-bulk-owner">New owner</Label>
            <OwnerSelect id="activity-bulk-owner" value={ownerId} onChange={setOwnerId} />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setReassignOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => ownerId && mutation.mutate({ action: "reassign", payload: { owner_id: ownerId } })}
              disabled={!ownerId}
              loading={mutation.isPending && mutation.variables?.action === "reassign"}
            >
              Reassign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
