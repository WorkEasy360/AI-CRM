"use client";

import * as React from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ListParams } from "@/lib/api/crm-types";
import { useDebounced } from "@/lib/crm/use-list-params";
import { cn } from "@/lib/utils";

export interface SortOption {
  value: string;
  label: string;
}

type View = "all" | "mine" | "archived";

function viewOf(params: ListParams): View {
  if (params.archived === "true") return "archived";
  if (params.owner === "me") return "mine";
  return "all";
}

/**
 * Compact toolbar shared by the CRM lists: a view selector (All / Mine / Archived), search-as-you-type,
 * a "Filters" toggle that reveals entity-specific filters, sort, and a slot for the primary action.
 * Advanced controls stay available but do not clutter the default screen.
 */
export function ListToolbar({
  params,
  setParam,
  setParams,
  clear,
  sortOptions,
  activeFilterCount,
  children,
  actions,
  entityLabel,
  searchPlaceholder = "Search…",
}: {
  params: ListParams;
  setParam: (key: string, value: string | undefined) => void;
  setParams: (patch: ListParams) => void;
  clear: () => void;
  sortOptions: SortOption[];
  activeFilterCount: number;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  /** Plural noun used in the view selector, e.g. "contacts". */
  entityLabel: string;
  searchPlaceholder?: string;
}) {
  const [draft, setDraft] = React.useState(params.q ?? "");
  const debounced = useDebounced(draft, 300);
  React.useEffect(() => {
    if ((params.q ?? "") !== debounced) setParam("q", debounced || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  React.useEffect(() => {
    if ((params.q ?? "") !== draft && params.q === undefined) setDraft("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.q]);

  const view = viewOf(params);
  // The view selector accounts for owner/archived; anything else counts as an "advanced" filter.
  const extraCount = Math.max(0, activeFilterCount - (params.owner === "me" ? 1 : 0) - (params.archived === "true" ? 1 : 0));
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const showFilters = Boolean(children) && (filtersOpen || extraCount > 0);

  const setView = (next: View) =>
    setParams({
      owner: next === "mine" ? "me" : undefined,
      archived: next === "archived" ? "true" : undefined,
    });

  const label = entityLabel.charAt(0).toUpperCase() + entityLabel.slice(1);

  return (
    <div className="mb-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={view} onValueChange={(v) => setView(v as View)}>
          <SelectTrigger className="h-8 w-44 font-medium" aria-label="View">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All {entityLabel}</SelectItem>
            <SelectItem value="mine">My {entityLabel}</SelectItem>
            <SelectItem value="archived">Archived {entityLabel}</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative w-full sm:w-60">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input aria-label={`Search ${entityLabel}`} placeholder={searchPlaceholder} value={draft} onChange={(e) => setDraft(e.target.value)} className="h-8 pl-8" maxLength={200} />
        </div>
        {children ? (
          <Button
            variant={showFilters ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setFiltersOpen((open) => !open)}
            aria-expanded={showFilters}
            aria-controls="list-filters"
            className={cn(!showFilters && "text-fg-muted")}
          >
            <SlidersHorizontal /> Filters
            {extraCount > 0 ? <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-fg">{extraCount}</span> : null}
          </Button>
        ) : null}
        {activeFilterCount > 0 || params.q ? (
          <Button variant="ghost" size="sm" onClick={clear} className="text-fg-muted">
            <X /> Clear
          </Button>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Select value={params.sort ?? sortOptions[0]?.value ?? ""} onValueChange={(v) => setParam("sort", v)}>
            <SelectTrigger className="h-8 w-40" aria-label="Sort">
              <SelectValue placeholder="Sort" />
            </SelectTrigger>
            <SelectContent>
              {sortOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {actions}
        </div>
      </div>
      {showFilters ? (
        <div id="list-filters" className="flex flex-wrap items-center gap-2 rounded-sm border border-border bg-surface px-3 py-2" aria-label={`${label} filters`}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
