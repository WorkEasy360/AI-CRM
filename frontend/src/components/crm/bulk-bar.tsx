"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Tag as TagIcon, UserRound, X } from "lucide-react";
import { OwnerSelect } from "@/components/crm/owner-select";
import { TagChip, useTags } from "@/components/crm/tag-picker";
import { useInvalidateRecord } from "@/components/crm/use-record-mutations";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { bulkAction } from "@/lib/api/crm";
import { errorMessage } from "@/lib/api/problem";
import { canReassign } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";

type BulkEntity = "contact" | "company";
type BulkInput = Parameters<typeof bulkAction>[1];

/**
 * Action bar shown above a list while rows are selected. The parent only renders it when the actor
 * holds `<module>.bulk_update`; reassigning additionally needs the `all` update scope.
 */
export function BulkBar({
  entity,
  selected,
  onClear,
  archivedView = false,
}: {
  entity: BulkEntity;
  selected: Set<string>;
  onClear: () => void;
  archivedView?: boolean;
}) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const path: "contacts" | "companies" = entity === "contact" ? "contacts" : "companies";
  const reassignAllowed = canReassign(active, path);
  const { tags } = useTags();
  const { toast } = useToast();
  const invalidate = useInvalidateRecord(entity);
  const [confirm, setConfirm] = React.useState<"archive" | "restore" | null>(null);
  const [reassignOpen, setReassignOpen] = React.useState(false);
  const [ownerId, setOwnerId] = React.useState("");

  const mutation = useMutation({
    mutationFn: (input: Omit<BulkInput, "ids">) => bulkAction(path, { ids: [...selected], ...input }),
    onSuccess: async (result) => {
      await invalidate();
      toast({
        tone: "success",
        title: `${result.affected.toLocaleString()} of ${result.requested.toLocaleString()} updated`,
        description: result.affected < result.requested ? "Some records were skipped because you cannot change them." : undefined,
      });
      setConfirm(null);
      setReassignOpen(false);
      setOwnerId("");
      onClear();
    },
    onError: (err) => toast({ tone: "error", title: "Bulk action failed", description: errorMessage(err) }),
  });

  const count = selected.size;
  if (count === 0) return null;
  const noun = entity === "contact" ? "contact" : "company";
  const plural = entity === "contact" ? "contacts" : "companies";
  const label = `${count.toLocaleString()} ${count === 1 ? noun : plural}`;

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary-soft px-3 py-2 text-sm"
    >
      <span className="font-medium text-primary">{label} selected</span>
      <div className="flex flex-wrap items-center gap-1">
        {archivedView ? (
          <Button variant="secondary" size="sm" onClick={() => setConfirm("restore")} loading={mutation.isPending && mutation.variables?.action === "restore"}>
            <ArchiveRestore /> Restore
          </Button>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setConfirm("archive")} loading={mutation.isPending && mutation.variables?.action === "archive"}>
            <Archive /> Archive
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" loading={mutation.isPending && mutation.variables?.action === "add_tag"}>
              <TagIcon /> Add tag
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            <DropdownMenuLabel>Add tag</DropdownMenuLabel>
            {tags.length === 0 ? <div className="px-2 py-1.5 text-sm text-fg-muted">No tags defined yet.</div> : null}
            {tags.map((t) => (
              <DropdownMenuItem key={t.id} onSelect={() => mutation.mutate({ action: "add_tag", payload: { tag_id: t.id } })}>
                <TagChip tag={t} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="secondary" size="sm" loading={mutation.isPending && mutation.variables?.action === "remove_tag"}>
              <TagIcon /> Remove tag
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            <DropdownMenuLabel>Remove tag</DropdownMenuLabel>
            {tags.length === 0 ? <div className="px-2 py-1.5 text-sm text-fg-muted">No tags defined yet.</div> : null}
            {tags.map((t) => (
              <DropdownMenuItem key={t.id} onSelect={() => mutation.mutate({ action: "remove_tag", payload: { tag_id: t.id } })}>
                <TagChip tag={t} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {reassignAllowed ? (
          <Button variant="secondary" size="sm" onClick={() => setReassignOpen(true)}>
            <UserRound /> Reassign
          </Button>
        ) : null}
      </div>
      <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label="Clear selection" onClick={onClear}>
        <X />
      </Button>

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm === "restore" ? `Restore ${label}?` : `Archive ${label}?`}
        description={
          confirm === "restore"
            ? "Restored records show up in lists and searches again."
            : "Archived records are hidden from lists and searches. You can restore them later."
        }
        confirmLabel={confirm === "restore" ? "Restore" : "Archive"}
        destructive={confirm === "archive"}
        loading={mutation.isPending}
        onConfirm={() => confirm && mutation.mutate({ action: confirm })}
      />

      <Dialog open={reassignOpen} onOpenChange={setReassignOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reassign {label}</DialogTitle>
            <DialogDescription>Choose the member who should own the selected records.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bulk-reassign-owner">New owner</Label>
            <OwnerSelect id="bulk-reassign-owner" value={ownerId} onChange={setOwnerId} />
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
