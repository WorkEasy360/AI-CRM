"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Tag as TagIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { listTags, setRecordTags } from "@/lib/api/crm";
import type { EntityType, TagRef } from "@/lib/api/crm-types";
import { ENTITY_PATHS } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { colorClasses } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { cn } from "@/lib/utils";

export function useTags() {
  const query = useQuery({ queryKey: crmKeys.tags, queryFn: listTags, staleTime: 5 * 60_000 });
  return { tags: query.data?.results ?? [], isPending: query.isPending };
}

export function TagChip({ tag, className }: { tag: TagRef; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", colorClasses(tag.color_token), className)}>
      {tag.name}
    </span>
  );
}

export function TagList({ tags, max = 3 }: { tags: TagRef[]; max?: number }) {
  if (tags.length === 0) return null;
  const shown = tags.slice(0, max);
  const extra = tags.length - shown.length;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {shown.map((t) => (
        <TagChip key={t.id} tag={t} />
      ))}
      {extra > 0 ? <span className="text-xs text-fg-subtle">+{extra}</span> : null}
    </span>
  );
}

/**
 * Tag selector for a record. Applies changes immediately (PUT /{entity}/{id}/tags/) and refreshes
 * the record and list caches.
 */
export function TagPicker({
  entity,
  recordId,
  current,
  disabled,
}: {
  entity: EntityType;
  recordId: string;
  current: TagRef[];
  disabled?: boolean;
}) {
  const { tags } = useTags();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const path = ENTITY_PATHS[entity];
  const currentIds = React.useMemo(() => new Set(current.map((t) => t.id)), [current]);

  const mutation = useMutation({
    mutationFn: (tag_ids: string[]) => setRecordTags(path, recordId, tag_ids),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: crmKeys.record(path, recordId) }),
        queryClient.invalidateQueries({ queryKey: ["crm", path, "list"] }),
        queryClient.invalidateQueries({ queryKey: ["crm", "deals", "board"] }),
      ]);
    },
    onError: (err) => toast({ tone: "error", title: "Could not update tags", description: errorMessage(err) }),
  });

  const toggle = (id: string) => {
    const next = new Set(currentIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    mutation.mutate([...next]);
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {current.map((t) => (
        <TagChip key={t.id} tag={t} />
      ))}
      {!disabled ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="Edit tags" loading={mutation.isPending}>
              <TagIcon /> {current.length === 0 ? "Add tags" : "Edit"}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
            <DropdownMenuLabel>Tags</DropdownMenuLabel>
            {tags.length === 0 ? <div className="px-2 py-1.5 text-sm text-fg-muted">No tags defined yet.</div> : null}
            {tags.map((t) => (
              <DropdownMenuItem key={t.id} onSelect={(e) => { e.preventDefault(); toggle(t.id); }}>
                <span className={cn("flex size-4 items-center justify-center", !currentIds.has(t.id) && "opacity-0")}>
                  <Check className="size-4 text-primary" aria-hidden />
                </span>
                <TagChip tag={t} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
