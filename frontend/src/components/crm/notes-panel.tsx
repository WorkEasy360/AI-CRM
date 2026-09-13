"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Textarea } from "@/components/ui/input";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { createNote, deleteNote, listNotes, updateNote } from "@/lib/api/crm";
import type { EntityType, Note } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { canDeleteNote, canEditNote, can } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { formatDateTime } from "@/lib/utils";

const MAX_NOTE = 20_000;

/** Notes for one record: list, add, edit (author/manager), pin, delete. */
export function NotesPanel({ entity, recordId }: { entity: EntityType; recordId: string }) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const key = crmKeys.notes(entity, recordId);
  const notes = useCursorList<Note>(key, (cursor) => listNotes(entity, recordId, cursor));
  const [draft, setDraft] = React.useState("");
  const [editing, setEditing] = React.useState<Note | null>(null);
  const [editDraft, setEditDraft] = React.useState("");
  const [deleting, setDeleting] = React.useState<Note | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: key }),
      queryClient.invalidateQueries({ queryKey: crmKeys.timeline(entity, recordId) }),
    ]);
  const fail = (title: string) => (err: unknown) => toast({ tone: "error", title, description: errorMessage(err) });

  const create = useMutation({
    mutationFn: (body: string) => createNote({ entity_type: entity, entity_id: recordId, body }),
    onSuccess: async () => {
      setDraft("");
      await refresh();
    },
    onError: fail("Could not add note"),
  });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: { body?: string; pinned?: boolean } }) => updateNote(id, input),
    onSuccess: async () => {
      setEditing(null);
      await refresh();
    },
    onError: fail("Could not update note"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteNote(id),
    onSuccess: async () => {
      setDeleting(null);
      await refresh();
    },
    onError: fail("Could not delete note"),
  });

  const canCreate = can(active, "notes.create");

  return (
    <section aria-label="Notes" className="flex flex-col gap-4">
      {canCreate ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) create.mutate(draft.trim());
          }}
        >
          <Textarea
            aria-label="New note"
            placeholder="Write a note… (plain text)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={MAX_NOTE}
            rows={3}
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-fg-subtle">{draft.length.toLocaleString()} / {MAX_NOTE.toLocaleString()}</span>
            <Button type="submit" size="sm" disabled={!draft.trim()} loading={create.isPending}>
              Add note
            </Button>
          </div>
        </form>
      ) : null}

      {notes.isPending ? (
        <SkeletonRows rows={2} />
      ) : notes.items.length === 0 ? (
        <EmptyState icon={<MessageSquare />} title="No notes yet" description="Notes keep the story of this record in one place." className="py-8" />
      ) : (
        <ul className="flex flex-col gap-3">
          {notes.items.map((note) => {
            const authorId = note.author?.id;
            const editable = canEditNote(active, authorId);
            const deletable = canDeleteNote(active, authorId);
            const isEditing = editing?.id === note.id;
            return (
              <li key={note.id} className="rounded-md border border-border bg-surface p-3">
                <div className="flex items-start gap-3">
                  <Avatar name={note.author?.display_name ?? "?"} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 text-xs text-fg-subtle">
                      <span className="font-medium text-fg">{note.author?.display_name ?? "Unknown"}</span>
                      <span>{formatDateTime(note.created_at)}</span>
                      {note.edited_at ? <span>(edited)</span> : null}
                      {note.pinned ? (
                        <span className="inline-flex items-center gap-1 text-primary">
                          <Pin className="size-3" aria-hidden /> Pinned
                        </span>
                      ) : null}
                    </div>
                    {isEditing ? (
                      <form
                        className="mt-2 flex flex-col gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (editDraft.trim()) update.mutate({ id: note.id, input: { body: editDraft.trim() } });
                        }}
                      >
                        <Textarea aria-label="Edit note" value={editDraft} onChange={(e) => setEditDraft(e.target.value)} maxLength={MAX_NOTE} rows={3} />
                        <div className="flex gap-2">
                          <Button type="submit" size="sm" loading={update.isPending}>
                            Save
                          </Button>
                          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                            Cancel
                          </Button>
                        </div>
                      </form>
                    ) : (
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm">{note.body}</p>
                    )}
                  </div>
                  {!isEditing && (editable || deletable) ? (
                    <div className="flex shrink-0 items-center gap-0.5">
                      {editable ? (
                        <>
                          <Button variant="ghost" size="icon-sm" aria-label={note.pinned ? "Unpin note" : "Pin note"} onClick={() => update.mutate({ id: note.id, input: { pinned: !note.pinned } })}>
                            {note.pinned ? <PinOff /> : <Pin />}
                          </Button>
                          <Button variant="ghost" size="icon-sm" aria-label="Edit note" onClick={() => { setEditing(note); setEditDraft(note.body); }}>
                            <Pencil />
                          </Button>
                        </>
                      ) : null}
                      {deletable ? (
                        <Button variant="ghost" size="icon-sm" aria-label="Delete note" onClick={() => setDeleting(note)}>
                          <Trash2 />
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {notes.hasMore ? (
        <Button variant="secondary" size="sm" onClick={() => notes.loadMore()} loading={notes.isLoadingMore} className="self-center">
          Load more
        </Button>
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this note?"
        description="This cannot be undone."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </section>
  );
}
