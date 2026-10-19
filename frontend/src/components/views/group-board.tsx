"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { getRecordGroupPage, getRecordGroups, saveRecordEdits } from "@/lib/api/crm";
import type { CellValue, EntityType, FieldDescriptor, ListParams, RecordGroup, RecordRow } from "@/lib/api/crm-types";
import { ENTITY_PATHS } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { useWindowedList } from "@/lib/use-windowed-list";
import { cn } from "@/lib/utils";
import { fieldMap, useModuleSchema } from "@/lib/views";
import { canEditInline, cellText } from "@/components/views/cells";

const CARD_H = 72;
const PER_GROUP = 50;
const DRAG_MIME = "application/x-keel-record";

/**
 * Kanban over any groupable field (lifecycle stage, source, a dropdown custom field, owner ...).
 * Dropping a card on another column is a one-cell edit through the same path as the Sheet view, so
 * it is versioned, audited and refused when the field is read-only for the member.
 */
export function GroupBoard({
  entity,
  filters,
  groupBy,
  onGroupByChange,
  columns: requested,
}: {
  entity: EntityType;
  filters: ListParams;
  groupBy: string | undefined;
  onGroupByChange: (key: string) => void;
  columns: string[];
}) {
  const schema = useModuleSchema(entity);
  const fields = React.useMemo(() => fieldMap(schema.data), [schema.data]);
  const groupable = (schema.data?.fields ?? []).filter((f) => f.groupable && f.type !== "stage" && f.key !== "pipeline");
  const field = (groupBy && fields.get(groupBy)) || groupable[0];
  const cardColumns = React.useMemo(() => {
    const keys = (requested.length ? requested : (schema.data?.default_columns ?? [])).filter((k) => k !== field?.key).slice(0, 3);
    return keys.map((k) => fields.get(k)).filter((f): f is FieldDescriptor => Boolean(f));
  }, [requested, schema.data, fields, field]);
  const params = React.useMemo(
    () => ({ ...filters, group_by: field?.key ?? "", per_group: PER_GROUP, columns: cardColumns.map((c) => c.key).join(",") }),
    [filters, field, cardColumns],
  );
  const qc = useQueryClient();
  const { toast } = useToast();
  const groups = useQuery({
    queryKey: crmKeys.groups(entity, params),
    queryFn: () => getRecordGroups(entity, params),
    enabled: Boolean(field),
    placeholderData: (prev) => prev,
  });
  const [extra, setExtra] = React.useState<Record<string, RecordRow[]>>({});
  const [moreLeft, setMoreLeft] = React.useState<Record<string, boolean>>({});
  const [dragging, setDragging] = React.useState<string | null>(null);
  React.useEffect(() => {
    setExtra({});
    setMoreLeft({});
  }, [groups.data]);

  if (schema.isPending) return <Skeleton className="h-72 w-full" />;
  if (!field) return <EmptyState title="Nothing to group by" description="This module has no field that can group records." />;
  const movable = canEditInline(field);
  const keyOf = (g: RecordGroup) => (g.value === null ? "" : String(g.value));

  const loadMore = async (g: RecordGroup) => {
    const key = keyOf(g);
    const shown = g.rows.length + (extra[key]?.length ?? 0);
    try {
      const page = await getRecordGroupPage(entity, { ...params, value: key, offset: shown, limit: PER_GROUP });
      setExtra((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), ...page.rows] }));
      setMoreLeft((prev) => ({ ...prev, [key]: page.has_more }));
    } catch (error) {
      toast({ tone: "error", title: "Could not load more", description: errorMessage(error) });
    }
  };

  const drop = async (row: RecordRow, target: RecordGroup) => {
    if (row.version === null) return;
    const value = field.type === "boolean" ? target.value === true : target.value;
    try {
      const result = await saveRecordEdits(entity, [{ id: row.id, version: row.version, values: { [field.key]: value } }]);
      const outcome = result.results[0];
      if (outcome && outcome.status !== "saved") {
        const err = outcome.errors[field.key] ?? outcome.errors._row;
        toast({ tone: "error", title: `Could not move “${row.title}”`, description: err?.message ?? "Reload and try again." });
      }
    } catch (error) {
      toast({ tone: "error", title: `Could not move “${row.title}”`, description: errorMessage(error) });
    }
    void qc.invalidateQueries({ queryKey: ["crm", "records", entity] });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2 flex items-center gap-2 text-xs text-fg-muted">
        <span>Group by</span>
        <Select value={field.key} onValueChange={onGroupByChange}>
          <SelectTrigger className="h-8 w-48" aria-label="Group by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {groupable.map((f) => (
              <SelectItem key={f.key} value={f.key}>
                {f.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!movable ? <span className="text-fg-subtle">{field.label} is read only for you: cards cannot be moved.</span> : null}
      </div>
      {groups.isError ? (
        <EmptyState title="Could not load the board" description={errorMessage(groups.error)} action={<Button variant="secondary" onClick={() => groups.refetch()}>Retry</Button>} />
      ) : !groups.data ? (
        <Skeleton className="h-72 w-full" />
      ) : (
        <ol className="-mx-1 flex min-h-0 flex-1 items-stretch gap-2.5 overflow-x-auto px-1 pb-2" aria-label={`${schema.data?.label_plural ?? "Records"} by ${field.label}`}>
          {groups.data.groups.map((g) => {
            const key = keyOf(g);
            const rows = [...g.rows, ...(extra[key] ?? [])];
            const hasMore = key in moreLeft ? moreLeft[key] : g.has_more;
            return (
              <GroupColumn
                key={key || "none"}
                group={g}
                rows={rows}
                columns={cardColumns}
                entity={entity}
                hasMore={Boolean(hasMore)}
                onLoadMore={() => loadMore(g)}
                movable={movable}
                dragging={dragging}
                setDragging={setDragging}
                onDrop={(id) => {
                  const all = groups.data!.groups.flatMap((x) => [...x.rows, ...(extra[keyOf(x)] ?? [])]);
                  const row = all.find((r) => r.id === id);
                  if (row && !rows.some((r) => r.id === id)) void drop(row, g);
                }}
              />
            );
          })}
        </ol>
      )}
    </div>
  );
}

function GroupColumn({
  group,
  rows,
  columns,
  entity,
  hasMore,
  onLoadMore,
  movable,
  dragging,
  setDragging,
  onDrop,
}: {
  group: RecordGroup;
  rows: RecordRow[];
  columns: FieldDescriptor[];
  entity: EntityType;
  hasMore: boolean;
  onLoadMore: () => void;
  movable: boolean;
  dragging: string | null;
  setDragging: (id: string | null) => void;
  onDrop: (id: string) => void;
}) {
  const [over, setOver] = React.useState(false);
  const win = useWindowedList({ count: rows.length, itemHeight: CARD_H + 6 });
  return (
    <li
      className={cn("flex w-64 shrink-0 flex-col rounded-md border bg-surface-sunken", over ? "border-primary bg-primary-soft/40" : "border-border")}
      onDragOver={(e) => {
        if (!movable || !dragging) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData(DRAG_MIME) || dragging;
        setDragging(null);
        if (id) onDrop(id);
      }}
    >
      <header className="flex items-center gap-2 px-2.5 pb-1.5 pt-2">
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-fg">{group.label}</h3>
        <span className="rounded-full bg-surface px-1.5 py-0.5 text-[12px] font-medium text-fg-muted">{group.count}</span>
      </header>
      <ul ref={win.ref as React.RefObject<HTMLUListElement>} className="flex min-h-20 flex-1 flex-col gap-1.5 overflow-y-auto px-1.5 pb-1.5" style={{ maxHeight: "calc(100vh - 260px)" }} aria-label={`${group.label} records`}>
        {win.padTop ? <li aria-hidden style={{ height: win.padTop }} /> : null}
        {rows.slice(win.start, win.end).map((row) => (
          <li
            key={row.id}
            draggable={movable}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_MIME, row.id);
              e.dataTransfer.effectAllowed = "move";
              setDragging(row.id);
            }}
            onDragEnd={() => setDragging(null)}
            className={cn("rounded-sm border border-border bg-surface px-2.5 py-2 shadow-sm", movable && "cursor-grab", dragging === row.id && "opacity-50")}
            style={{ minHeight: CARD_H }}
          >
            <Link prefetch={false} href={`/${ENTITY_PATHS[entity]}/${encodeURIComponent(row.id)}`} className="block truncate text-sm font-medium text-fg hover:text-primary hover:underline" draggable={false}>
              {row.title || "Untitled"}
            </Link>
            {columns.map((c) => {
              const text = cellText(c, row.values[c.key] as CellValue);
              return text ? (
                <p key={c.key} className="truncate text-xs text-fg-muted" title={`${c.label}: ${text}`}>
                  {text}
                </p>
              ) : null;
            })}
          </li>
        ))}
        {win.padBottom ? <li aria-hidden style={{ height: win.padBottom }} /> : null}
        {rows.length === 0 ? <li className="py-5 text-center text-xs text-fg-subtle">Empty</li> : null}
      </ul>
      {hasMore ? (
        <button type="button" className="border-t border-border px-2.5 py-1.5 text-left text-[12px] text-primary hover:underline" onClick={onLoadMore}>
          Show more ({group.count - rows.length} left)
        </button>
      ) : null}
    </li>
  );
}
