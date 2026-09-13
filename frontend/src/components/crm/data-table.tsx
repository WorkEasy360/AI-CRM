"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  /** Public sort key accepted by the API (`sort=` / `sort=-`). */
  sortKey?: string;
  className?: string;
  render: (row: T) => React.ReactNode;
}

export interface DataTableProps<T extends { id: string }> {
  rows: T[];
  columns: Column<T>[];
  sort?: string;
  onSort?: (sort: string) => void;
  /** Link target for the whole row (rendered on the first column). */
  rowHref?: (row: T) => string;
  selectable?: boolean;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  onToggleAll?: (ids: string[]) => void;
  isPending?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: React.ReactNode;
  hasMore?: boolean;
  onLoadMore?: () => void;
  isLoadingMore?: boolean;
  caption?: string;
}

function SortIcon({ active, desc }: { active: boolean; desc: boolean }) {
  if (!active) return <ArrowUpDown className="size-3.5 opacity-50" aria-hidden />;
  return desc ? <ArrowDown className="size-3.5" aria-hidden /> : <ArrowUp className="size-3.5" aria-hidden />;
}

/** Generic sortable, selectable, cursor-paginated table for CRM lists. */
export function DataTable<T extends { id: string }>({
  rows,
  columns,
  sort,
  onSort,
  rowHref,
  selectable,
  selected,
  onToggle,
  onToggleAll,
  isPending,
  isError,
  error,
  onRetry,
  empty,
  hasMore,
  onLoadMore,
  isLoadingMore,
  caption,
}: DataTableProps<T>) {
  const desc = Boolean(sort?.startsWith("-"));
  const sortKey = sort?.replace(/^-/, "");
  const allSelected = selectable && rows.length > 0 && rows.every((r) => selected?.has(r.id));

  if (isPending) return <SkeletonRows rows={6} />;
  if (isError) {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    return (
      <EmptyState
        title="Could not load records"
        description={message}
        action={onRetry ? <Button variant="secondary" onClick={onRetry}>Retry</Button> : undefined}
      />
    );
  }
  if (rows.length === 0) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;

  return (
    <div>
      <Table>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <TableHeader>
          <TableRow>
            {selectable ? (
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  aria-label="Select all rows"
                  className="size-4 accent-[var(--kl-primary)]"
                  checked={Boolean(allSelected)}
                  onChange={() => onToggleAll?.(rows.map((r) => r.id))}
                />
              </TableHead>
            ) : null}
            {columns.map((col) => {
              const active = Boolean(col.sortKey) && col.sortKey === sortKey;
              return (
                <TableHead key={col.key} className={col.className} aria-sort={active ? (desc ? "descending" : "ascending") : undefined}>
                  {col.sortKey && onSort ? (
                    <button
                      type="button"
                      className={cn("inline-flex items-center gap-1 hover:text-fg", active && "text-fg")}
                      onClick={() => onSort(active && !desc ? `-${col.sortKey}` : col.sortKey!)}
                    >
                      {col.header}
                      <SortIcon active={active} desc={desc} />
                    </button>
                  ) : (
                    col.header
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} className={cn(selected?.has(row.id) && "bg-primary-soft/40")}>
              {selectable ? (
                <TableCell>
                  <input
                    type="checkbox"
                    aria-label="Select row"
                    className="size-4 accent-[var(--kl-primary)]"
                    checked={Boolean(selected?.has(row.id))}
                    onChange={() => onToggle?.(row.id)}
                  />
                </TableCell>
              ) : null}
              {columns.map((col, index) => (
                <TableCell key={col.key} className={col.className}>
                  {index === 0 && rowHref ? (
                    <Link href={rowHref(row)} className="font-medium text-fg hover:text-primary hover:underline">
                      {col.render(row)}
                    </Link>
                  ) : (
                    col.render(row)
                  )}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {hasMore ? (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" onClick={onLoadMore} loading={isLoadingMore}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Selection state helper for bulk actions. */
export function useSelection() {
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const toggle = React.useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const toggleAll = React.useCallback((ids: string[]) => {
    setSelected((prev) => {
      const all = ids.every((id) => prev.has(id));
      const next = new Set(prev);
      for (const id of ids) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, []);
  const clear = React.useCallback(() => setSelected(new Set()), []);
  return { selected, toggle, toggleAll, clear };
}
