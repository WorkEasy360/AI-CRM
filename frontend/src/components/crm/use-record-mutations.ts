"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/toast";
import { archiveRecord, restoreRecord } from "@/lib/api/crm";
import type { EntityType } from "@/lib/api/crm-types";
import { ENTITY_PATHS } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";

/** Invalidate everything that could show a record after a write. */
export function useInvalidateRecord(entity: EntityType) {
  const queryClient = useQueryClient();
  const path = ENTITY_PATHS[entity];
  return async (id?: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["crm", path] }),
      queryClient.invalidateQueries({ queryKey: ["crm", "deals", "board"] }),
      id ? queryClient.invalidateQueries({ queryKey: crmKeys.record(path, id) }) : Promise.resolve(),
      id ? queryClient.invalidateQueries({ queryKey: crmKeys.timeline(entity, id) }) : Promise.resolve(),
    ]);
  };
}

/** A version conflict (409) means someone else saved first; the UI offers a reload. */
export function isVersionConflict(error: unknown): boolean {
  return isApiError(error) && error.status === 409 && error.type === "version_conflict";
}

/**
 * Archive/restore for a record. The API soft-deletes, so a surface that calls the action "Delete"
 * (the deal page) passes `wording: "delete"` and gets matching toasts; everything else says archive.
 */
export function useArchiveRestore(entity: EntityType, wording: "archive" | "delete" = "archive") {
  const { toast } = useToast();
  const archivedTitle = wording === "delete" ? "Deleted" : "Archived";
  const archiveFailure = wording === "delete" ? "Could not delete" : "Could not archive";
  const invalidate = useInvalidateRecord(entity);
  const path = ENTITY_PATHS[entity];
  const archive = useMutation({
    mutationFn: (id: string) => archiveRecord(path, id),
    onSuccess: async (_data, id) => {
      await invalidate(id);
      toast({ tone: "success", title: archivedTitle, description: "The record is hidden from lists and can be restored." });
    },
    onError: (err) => toast({ tone: "error", title: archiveFailure, description: errorMessage(err) }),
  });
  const restore = useMutation({
    mutationFn: (id: string) => restoreRecord(path, id),
    onSuccess: async (_data, id) => {
      await invalidate(id);
      toast({ tone: "success", title: "Restored" });
    },
    onError: (err) => toast({ tone: "error", title: "Could not restore", description: errorMessage(err) }),
  });
  return { archive, restore };
}
