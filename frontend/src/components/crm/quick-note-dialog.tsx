"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { createNote } from "@/lib/api/crm";
import { ENTITY_LABELS, type EntityType, type Note } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";

const MAX_NOTE = 20_000;

/** Small "add a note" dialog for the record header quick actions. */
export function QuickNoteDialog({
  open,
  onOpenChange,
  entity,
  recordId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entity: EntityType;
  recordId: string;
  onSaved?: (note: Note) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [body, setBody] = React.useState("");
  const id = React.useId();

  React.useEffect(() => {
    if (open) setBody("");
  }, [open]);

  const create = useMutation({
    mutationFn: (text: string) => createNote({ entity_type: entity, entity_id: recordId, body: text }),
    onSuccess: async (note) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: crmKeys.notes(entity, recordId) }),
        queryClient.invalidateQueries({ queryKey: crmKeys.timeline(entity, recordId) }),
      ]);
      toast({ tone: "success", title: "Note added" });
      onSaved?.(note);
      onOpenChange(false);
    },
    onError: (err) => toast({ tone: "error", title: "Could not add note", description: errorMessage(err) }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) create.mutate(body.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>Add a note</DialogTitle>
            <DialogDescription>Saved to this {ENTITY_LABELS[entity].singular.toLowerCase()}&apos;s notes and timeline.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id}>Note</Label>
            <Textarea id={id} autoFocus rows={4} maxLength={MAX_NOTE} placeholder="Write a note… (plain text)" value={body} onChange={(e) => setBody(e.target.value)} />
            <span className="text-xs text-fg-subtle">
              {body.length.toLocaleString()} / {MAX_NOTE.toLocaleString()}
            </span>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!body.trim()} loading={create.isPending}>
              Add note
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
