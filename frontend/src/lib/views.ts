"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  clearDefaultSavedView,
  createSavedView,
  deleteSavedView,
  getModuleSchema,
  listSavedViews,
  setDefaultSavedView,
  updateSavedView,
} from "@/lib/api/crm";
import type { EntityType, FieldDescriptor, ListParams, ModuleSchema, SavedView, SavedViewInput, ViewKind } from "@/lib/api/crm-types";
import { crmKeys } from "@/lib/crm/keys";

/**
 * URL keys that describe *how* records are shown (the view), as opposed to which records (filters).
 * Pages keep both in the URL so a view is shareable; the view keys must never reach a list endpoint,
 * whose FilterSet answers 400 to unknown parameters.
 */
export const VIEW_KEYS = ["view", "saved", "cols", "group", "datef", "measure", "mfield", "acts"] as const;
export const VIEW_KINDS: ViewKind[] = ["list", "kanban", "sheet", "calendar", "chart"];
export const VIEW_LABELS: Record<ViewKind, string> = {
  list: "List",
  kanban: "Kanban",
  sheet: "Sheet",
  calendar: "Calendar",
  chart: "Chart",
};

/** Keys a page owns that are neither filters nor view keys (dialogs, prefills). */
const UI_KEYS = new Set(["new", "pipeline", ...VIEW_KEYS]);

/** The filter part of a page's URL state, ready for the API. */
export function filterParams(params: ListParams, keep: readonly string[] = []): ListParams {
  const out: ListParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    if (UI_KEYS.has(key) && !keep.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

export function viewKindOf(value: string | undefined, fallback: ViewKind = "list"): ViewKind {
  return VIEW_KINDS.includes(value as ViewKind) ? (value as ViewKind) : fallback;
}

export function columnsOf(params: ListParams): string[] {
  return (params.cols ?? "").split(",").filter(Boolean);
}

/** URL patch that opens a saved view: its filters replace the current ones. */
export function applySavedView(view: SavedView, current: ListParams, ownedKeys: readonly string[] = []): ListParams {
  const patch: ListParams = {};
  for (const key of Object.keys(current)) {
    if (!ownedKeys.includes(key)) patch[key] = undefined;
  }
  Object.assign(patch, view.filters);
  patch.sort = view.sort || undefined;
  patch.view = view.kind;
  patch.saved = view.id;
  patch.cols = view.columns.length ? view.columns.join(",") : undefined;
  patch.group = view.config.group_by;
  patch.datef = view.config.date_field;
  patch.measure = view.config.measure;
  patch.mfield = view.config.field;
  patch.acts = view.config.include_activities === false ? "0" : undefined;
  return patch;
}

/** What "Save view" stores, read back from the URL state. */
export function savedViewInputFrom(params: ListParams, kind: ViewKind, extraFilterKeys: readonly string[] = []): SavedViewInput {
  const filters = filterParams(params, extraFilterKeys);
  const { sort, ...rest } = filters;
  const config: SavedViewInput["config"] = {};
  if (params.group) config.group_by = params.group;
  if (params.pipeline && kind === "kanban") config.pipeline_id = params.pipeline;
  if (params.datef) config.date_field = params.datef;
  if (kind === "calendar") config.include_activities = params.acts !== "0";
  if (params.measure) config.measure = params.measure as "count" | "sum";
  if (params.mfield) config.field = params.mfield;
  return { kind, filters: rest as Record<string, string>, sort: sort ?? "", columns: columnsOf(params), config };
}

export function useModuleSchema(entity: EntityType) {
  return useQuery<ModuleSchema>({ queryKey: crmKeys.schema(entity), queryFn: () => getModuleSchema(entity), staleTime: 60_000 });
}

export function fieldMap(schema: ModuleSchema | undefined): Map<string, FieldDescriptor> {
  return new Map((schema?.fields ?? []).map((f) => [f.key, f]));
}

export function useSavedViews(entity: EntityType) {
  const qc = useQueryClient();
  const key = crmKeys.savedViews(entity);
  const views = useQuery({ queryKey: key, queryFn: () => listSavedViews(entity), staleTime: 30_000 });
  const invalidate = React.useCallback(() => qc.invalidateQueries({ queryKey: key }), [qc, key]);
  const create = useMutation({ mutationFn: (input: SavedViewInput) => createSavedView({ ...input, entity_type: entity }), onSuccess: invalidate });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: SavedViewInput & { version?: number } }) => updateSavedView(id, input),
    onSuccess: invalidate,
  });
  const remove = useMutation({ mutationFn: (id: string) => deleteSavedView(id), onSuccess: invalidate });
  const makeDefault = useMutation({ mutationFn: (id: string) => setDefaultSavedView(id), onSuccess: invalidate });
  const clearDefault = useMutation({ mutationFn: () => clearDefaultSavedView(entity), onSuccess: invalidate });
  return { views, create, update, remove, makeDefault, clearDefault };
}

/**
 * Opens the member's default view the first time a page is visited with nothing in the URL.
 * Runs once per mount: after that the URL is the source of truth.
 */
export function useDefaultView(
  views: SavedView[] | undefined,
  params: ListParams,
  apply: (view: SavedView) => void,
  ignoredKeys: readonly string[] = [],
) {
  const done = React.useRef(false);
  React.useEffect(() => {
    if (done.current || !views) return;
    done.current = true;
    const hasState = Object.entries(params).some(([k, v]) => v && !ignoredKeys.includes(k));
    if (hasState) return;
    const fallback = views.find((v) => v.is_default);
    if (fallback) apply(fallback);
  }, [views, params, apply, ignoredKeys]);
}
