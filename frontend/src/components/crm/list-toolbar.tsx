"use client";

import * as React from "react";
import { Archive, Search, X } from "lucide-react";
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

/**
 * Toolbar shared by the CRM lists: search-as-you-type, owner filter (mine / everyone), archived
 * toggle, sort select and a slot for entity-specific filters and actions.
 */
export function ListToolbar({
  params,
  setParam,
  clear,
  sortOptions,
  activeFilterCount,
  children,
  actions,
  searchPlaceholder = "Search…",
}: {
  params: ListParams;
  setParam: (key: string, value: string | undefined) => void;
  clear: () => void;
  sortOptions: SortOption[];
  activeFilterCount: number;
  children?: React.ReactNode;
  actions?: React.ReactNode;
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

  const archived = params.archived === "true";

  return (
    <div className="mb-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input
            aria-label="Search"
            placeholder={searchPlaceholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="pl-8"
            maxLength={200}
          />
        </div>
        <Select value={params.owner === "me" ? "me" : "all"} onValueChange={(v) => setParam("owner", v === "me" ? "me" : undefined)}>
          <SelectTrigger className="w-36" aria-label="Owner filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everyone&apos;s</SelectItem>
            <SelectItem value="me">Mine</SelectItem>
          </SelectContent>
        </Select>
        <Select value={params.sort ?? sortOptions[0]?.value ?? ""} onValueChange={(v) => setParam("sort", v)}>
          <SelectTrigger className="w-44" aria-label="Sort">
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
        {children}
        <Button
          variant={archived ? "primary" : "ghost"}
          size="sm"
          onClick={() => setParam("archived", archived ? undefined : "true")}
          aria-pressed={archived}
          className={cn(!archived && "text-fg-muted")}
        >
          <Archive /> Archived
        </Button>
        {activeFilterCount > 0 || params.q ? (
          <Button variant="ghost" size="sm" onClick={clear}>
            <X /> Clear
          </Button>
        ) : null}
        {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
