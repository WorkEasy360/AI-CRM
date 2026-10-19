"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ExternalLink, RotateCcw, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { getRecordRows, listPipelines, saveRecordEdits } from "@/lib/api/crm";
import type { CellValue, EntityType, FieldDescriptor, ListParams, RecordRow } from "@/lib/api/crm-types";
import { ENTITY_PATHS } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { cn } from "@/lib/utils";
import { fieldMap, useModuleSchema } from "@/lib/views";
import { CellEditor, canEditInline, cellText, parseCell, rawOf } from "@/components/views/cells";
import { ColumnPicker } from "@/components/views/column-picker";

const ROW_H = 34;
const WINDOW = 100;
const SAVE_CHUNK = 500;
const OVERSCAN = 10;

interface Pos {
  r: number;
  c: number;
}
interface PendingCell {
  value: unknown;
  text: string;
}

/**
 * Spreadsheet-style grid over any module. Rows are read in windows of 100 by offset, so a
 * million-record organization scrolls without loading the set; only visible rows are rendered.
 * Edits (typing, paste, fill-down, clear) collect locally and are saved in batches: each row is
 * written through the module's normal update on the server, so field rules, versions, audit and
 * events apply per record. The server's answer is shown per cell: saved, refused (hidden or read-only
 * field, invalid value) or a conflict with someone else's change.
 */
export function SheetView({
  entity,
  filters,
  columns: requested,
  onColumnsChange,
}: {
  entity: EntityType;
  filters: ListParams;
  columns: string[];
  onColumnsChange: (columns: string[]) => void;
}) {
  const { toast } = useToast();
  const schema = useModuleSchema(entity);
  const fields = React.useMemo(() => fieldMap(schema.data), [schema.data]);
  const columns = React.useMemo<FieldDescriptor[]>(() => {
    const keys = requested.length ? requested : (schema.data?.default_columns ?? []);
    return keys.map((k) => fields.get(k)).filter((f): f is FieldDescriptor => Boolean(f));
  }, [requested, schema.data, fields]);
  const needsPipeline = entity === "deal" && columns.some((c) => c.type === "stage");
  const fetchKeys = React.useMemo(() => {
    const keys = columns.map((c) => c.key);
    if (needsPipeline && !keys.includes("pipeline")) keys.push("pipeline");
    for (const c of columns) if (c.currency_field && !keys.includes(c.currency_field) && fields.has(c.currency_field)) keys.push(c.currency_field);
    return keys;
  }, [columns, needsPipeline, fields]);

  const pipelines = useQuery({ queryKey: crmKeys.pipelines, queryFn: () => listPipelines(), enabled: needsPipeline, staleTime: 60_000 });
  const stagesByPipeline = React.useMemo(() => {
    const out = new Map<string, { id: string; name: string }[]>();
    for (const p of pipelines.data?.results ?? []) out.set(p.id, p.stages.map((s) => ({ id: s.id, name: s.name })));
    return out;
  }, [pipelines.data]);

  // ---------------------------------------------------------------- windowed data
  const identity = JSON.stringify([entity, filters, fetchKeys]);
  const [pages, setPages] = React.useState<Record<number, RecordRow[]>>({});
  const [total, setTotal] = React.useState<number | null>(null);
  const [exact, setExact] = React.useState(true);
  const [loadError, setLoadError] = React.useState<unknown>(null);
  const loading = React.useRef(new Set<number>());
  const generation = React.useRef(0);

  const [pending, setPending] = React.useState<Map<string, Map<string, PendingCell>>>(new Map());
  const [errors, setErrors] = React.useState<Map<string, string>>(new Map());
  const [conflicts, setConflicts] = React.useState<Set<string>>(new Set());
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    generation.current += 1;
    loading.current.clear();
    setPages({});
    setTotal(null);
    setLoadError(null);
    setPending(new Map());
    setErrors(new Map());
    setConflicts(new Set());
  }, [identity]);

  const loadPage = React.useCallback(
    (index: number) => {
      if (fetchKeys.length === 0 || loading.current.has(index)) return;
      loading.current.add(index);
      const gen = generation.current;
      getRecordRows(entity, { ...filters, offset: index * WINDOW, limit: WINDOW, columns: fetchKeys.join(",") })
        .then((data) => {
          if (gen !== generation.current) return;
          setTotal(data.total);
          setExact(data.exact);
          setPages((prev) => ({ ...prev, [index]: data.rows }));
        })
        .catch((error) => {
          if (gen === generation.current) setLoadError(error);
        })
        .finally(() => {
          if (gen === generation.current) loading.current.delete(index);
        });
    },
    [entity, filters, fetchKeys],
  );

  const scroller = React.useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [viewport, setViewport] = React.useState(600);
  React.useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight || 600);
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);

  const count = total ?? WINDOW;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(count, Math.ceil((scrollTop + viewport) / ROW_H) + OVERSCAN);
  React.useEffect(() => {
    if (schema.isPending) return;
    for (let p = Math.floor(first / WINDOW); p <= Math.floor(Math.max(first, last - 1) / WINDOW); p += 1) {
      if (!pages[p]) loadPage(p);
    }
  }, [first, last, pages, loadPage, schema.isPending, identity]);

  const rowAt = React.useCallback((r: number): RecordRow | undefined => pages[Math.floor(r / WINDOW)]?.[r % WINDOW], [pages]);

  // ---------------------------------------------------------------- selection and editing
  const [focus, setFocus] = React.useState<Pos>({ r: 0, c: 0 });
  const [anchor, setAnchor] = React.useState<Pos>({ r: 0, c: 0 });
  const [editing, setEditing] = React.useState<{ pos: Pos; initial: string } | null>(null);
  const grid = React.useRef<HTMLDivElement | null>(null);
  const range = {
    r0: Math.min(anchor.r, focus.r),
    r1: Math.max(anchor.r, focus.r),
    c0: Math.min(anchor.c, focus.c),
    c1: Math.max(anchor.c, focus.c),
  };
  const inRange = (r: number, c: number) => r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1;

  const stageMapFor = React.useCallback(
    (row: RecordRow | undefined) => {
      const pipeline = row?.values.pipeline as { id?: string } | null | undefined;
      const stages = (pipeline?.id && stagesByPipeline.get(pipeline.id)) || [];
      return { options: stages, byName: new Map(stages.map((s) => [s.name.toLowerCase(), s.id])) };
    },
    [stagesByPipeline],
  );

  const displayText = React.useCallback(
    (row: RecordRow, field: FieldDescriptor) => {
      const p = pending.get(row.id)?.get(field.key);
      if (p) return p.text;
      const currency = field.currency_field ? (row.values[field.currency_field] as string | undefined) : undefined;
      return cellText(field, row.values[field.key] as CellValue, currency);
    },
    [pending],
  );

  /** Stage an edit locally. Refusals the server would make are shown immediately as well. */
  const stage = React.useCallback(
    (edits: { r: number; c: number; text: string }[]) => {
      const nextPending = new Map(pending);
      const nextErrors = new Map(errors);
      let refused = 0;
      for (const { r, c, text } of edits) {
        const row = rowAt(r);
        const field = columns[c];
        if (!row || !field || row.version === null) continue;
        const key = `${row.id}:${field.key}`;
        if (!canEditInline(field)) {
          nextErrors.set(key, field.read_only ? "You can view this field but not change it." : "This field cannot be edited here.");
          refused += 1;
          continue;
        }
        const parsed = parseCell(field, text, stageMapFor(row).byName);
        if (!parsed.ok) {
          nextErrors.set(key, parsed.error);
          refused += 1;
          continue;
        }
        nextErrors.delete(key);
        const cells = new Map(nextPending.get(row.id) ?? []);
        cells.set(field.key, { value: parsed.value, text: field.type === "stage" || field.type === "choice" ? text : text.trim() });
        nextPending.set(row.id, cells);
      }
      setPending(nextPending);
      setErrors(nextErrors);
      if (refused) toast({ tone: "error", title: `${refused} ${refused === 1 ? "cell was" : "cells were"} not changed`, description: "See the marked cells." });
    },
    [pending, errors, rowAt, columns, stageMapFor, toast],
  );

  const copySelection = React.useCallback(
    async (event?: ClipboardEvent | React.ClipboardEvent) => {
      const lines: string[] = [];
      for (let r = range.r0; r <= range.r1; r += 1) {
        const row = rowAt(r);
        const cells: string[] = [];
        for (let c = range.c0; c <= range.c1; c += 1) {
          const field = columns[c];
          cells.push(row && field ? displayText(row, field).replace(/[\t\n]/g, " ") : "");
        }
        lines.push(cells.join("\t"));
      }
      const tsv = lines.join("\n");
      if (event && "clipboardData" in event && event.clipboardData) {
        event.preventDefault();
        event.clipboardData.setData("text/plain", tsv);
      } else {
        await navigator.clipboard?.writeText(tsv).catch(() => undefined);
      }
    },
    [range.r0, range.r1, range.c0, range.c1, rowAt, columns, displayText],
  );

  const paste = React.useCallback(
    (text: string) => {
      const matrix = text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((line) => line.split("\t"));
      const single = matrix.length === 1 && matrix[0]!.length === 1;
      const edits: { r: number; c: number; text: string }[] = [];
      if (single) {
        // One value pasted onto a selection fills the whole selection.
        for (let r = range.r0; r <= range.r1; r += 1) for (let c = range.c0; c <= range.c1; c += 1) edits.push({ r, c, text: matrix[0]![0]! });
      } else {
        matrix.forEach((cells, i) => cells.forEach((value, j) => edits.push({ r: range.r0 + i, c: range.c0 + j, text: value })));
      }
      stage(edits.filter((e) => e.c < columns.length && e.r < count));
    },
    [range.r0, range.r1, range.c0, range.c1, stage, columns.length, count],
  );

  const fillDown = React.useCallback(() => {
    const edits: { r: number; c: number; text: string }[] = [];
    for (let c = range.c0; c <= range.c1; c += 1) {
      const top = rowAt(range.r0);
      const field = columns[c];
      if (!top || !field) continue;
      const pendingTop = pending.get(top.id)?.get(field.key);
      const text = pendingTop ? pendingTop.text : field.type === "stage" ? cellText(field, top.values[field.key] as CellValue) : rawOf(field, top.values[field.key] as CellValue);
      for (let r = range.r0 + 1; r <= range.r1; r += 1) edits.push({ r, c, text });
    }
    stage(edits);
  }, [range.r0, range.r1, range.c0, range.c1, rowAt, columns, pending, stage]);

  const move = (dr: number, dc: number, extend: boolean) => {
    const next = { r: Math.max(0, Math.min(count - 1, focus.r + dr)), c: Math.max(0, Math.min(columns.length - 1, focus.c + dc)) };
    setFocus(next);
    if (!extend) setAnchor(next);
    const el = scroller.current;
    if (el) {
      const top = next.r * ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H * 2 > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H * 2 - el.clientHeight;
    }
  };

  const startEdit = (pos: Pos, initial?: string) => {
    const row = rowAt(pos.r);
    const field = columns[pos.c];
    if (!row || !field) return;
    if (!canEditInline(field)) {
      setErrors((prev) => new Map(prev).set(`${row.id}:${field.key}`, field.read_only ? "You can view this field but not change it." : "This field cannot be edited here."));
      return;
    }
    const current = pending.get(row.id)?.get(field.key);
    const value =
      initial ??
      (current ? current.text : field.type === "stage" ? cellText(field, row.values[field.key] as CellValue) : rawOf(field, row.values[field.key] as CellValue));
    setEditing({ pos, initial: field.type === "boolean" && !initial ? rawOf(field, row.values[field.key] as CellValue) : value });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "ArrowDown") move(1, 0, e.shiftKey);
    else if (e.key === "ArrowUp") move(-1, 0, e.shiftKey);
    else if (e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey)) move(0, 1, e.key !== "Tab" && e.shiftKey);
    else if (e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey)) move(0, -1, e.key !== "Tab" && e.shiftKey);
    else if (e.key === "Enter" || e.key === "F2") startEdit(focus);
    else if (mod && e.key.toLowerCase() === "d") fillDown();
    else if (e.key === "Delete" || e.key === "Backspace") {
      const edits = [];
      for (let r = range.r0; r <= range.r1; r += 1) for (let c = range.c0; c <= range.c1; c += 1) edits.push({ r, c, text: "" });
      stage(edits);
    } else if (!mod && e.key.length === 1) {
      startEdit(focus, e.key);
    } else return;
    e.preventDefault();
  };

  // ---------------------------------------------------------------- saving
  const dirtyRows = pending.size;
  const save = async () => {
    const rows: { id: string; version: number; values: Record<string, unknown> }[] = [];
    const byId = new Map<string, RecordRow>();
    for (const page of Object.values(pages)) for (const row of page) byId.set(row.id, row);
    for (const [id, cells] of pending) {
      const row = byId.get(id);
      if (!row || row.version === null) continue;
      rows.push({ id, version: row.version, values: Object.fromEntries([...cells].map(([k, v]) => [k, v.value])) });
    }
    if (rows.length === 0) return;
    setSaving(true);
    const nextPending = new Map(pending);
    const nextErrors = new Map(errors);
    const nextConflicts = new Set(conflicts);
    const updated = new Map<string, RecordRow>();
    let saved = 0;
    let failed = 0;
    try {
      for (let i = 0; i < rows.length; i += SAVE_CHUNK) {
        const response = await saveRecordEdits(entity, rows.slice(i, i + SAVE_CHUNK));
        for (const result of response.results) {
          const row = byId.get(result.id);
          if (!row) continue;
          const cells = new Map(nextPending.get(result.id) ?? []);
          if (result.status === "conflict") {
            // Someone else saved first: show their values and drop this row's unsaved edits.
            nextConflicts.add(result.id);
            cells.clear();
            failed += 1;
          } else {
            nextConflicts.delete(result.id);
          }
          if (result.values) updated.set(result.id, { ...row, version: result.version ?? row.version, values: { ...row.values, ...result.values } });
          else if (result.version) updated.set(result.id, { ...row, version: result.version });
          for (const key of [...cells.keys()]) {
            const err = result.errors[key] ?? (result.status === "error" ? result.errors._row : undefined);
            if (err && result.status !== "conflict") {
              nextErrors.set(`${result.id}:${key}`, err.message);
            } else if (result.status !== "conflict") {
              nextErrors.delete(`${result.id}:${key}`);
              cells.delete(key);
            }
          }
          if (result.status === "saved" || result.status === "partial") saved += 1;
          else if (result.status === "error") failed += 1;
          if (cells.size === 0) nextPending.delete(result.id);
          else nextPending.set(result.id, cells);
        }
      }
    } catch (error) {
      toast({ tone: "error", title: "Could not save the changes", description: errorMessage(error) });
    } finally {
      setPages((prev) => {
        const next: Record<number, RecordRow[]> = {};
        for (const [k, page] of Object.entries(prev)) next[Number(k)] = page.map((row) => updated.get(row.id) ?? row);
        return next;
      });
      setPending(nextPending);
      setErrors(nextErrors);
      setConflicts(nextConflicts);
      setSaving(false);
    }
    if (saved) toast({ tone: "success", title: `Saved ${saved} ${saved === 1 ? "record" : "records"}` });
    if (failed) toast({ tone: "error", title: `${failed} ${failed === 1 ? "record needs" : "records need"} attention`, description: "Rows changed by someone else now show their values; marked cells need fixing." });
  };

  const discard = (rowId?: string) => {
    if (rowId) {
      setPending((prev) => {
        const next = new Map(prev);
        next.delete(rowId);
        return next;
      });
      setConflicts((prev) => {
        const next = new Set(prev);
        next.delete(rowId);
        return next;
      });
      setErrors((prev) => new Map([...prev].filter(([k]) => !k.startsWith(`${rowId}:`))));
    } else {
      setPending(new Map());
      setErrors(new Map());
      setConflicts(new Set());
    }
  };

  // ---------------------------------------------------------------- render
  if (schema.isError) return <EmptyState title="Could not load the fields" description={errorMessage(schema.error)} />;
  if (loadError) {
    return (
      <EmptyState
        title="Could not load the records"
        description={errorMessage(loadError)}
        action={
          <Button
            variant="secondary"
            onClick={() => {
              setLoadError(null);
              setPages({});
            }}
          >
            Retry
          </Button>
        }
      />
    );
  }
  const widths = columns.map((c) => (c.type === "textarea" ? 260 : c.key === schema.data?.title_field || c.key === "name" ? 220 : 160));
  const gridWidth = 40 + widths.reduce((a, b) => a + b, 0);
  const path = ENTITY_PATHS[entity];
  const visible: number[] = [];
  for (let r = first; r < last; r += 1) visible.push(r);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <span aria-live="polite">
          {total === null ? "Loading…" : `${total.toLocaleString()}${exact ? "" : "+"} ${total === 1 ? "record" : "records"}`}
        </span>
        <span className="hidden sm:inline text-fg-subtle">Copy, paste and fill down (Ctrl+D) like a spreadsheet; edits save together.</span>
        <div className="ml-auto flex items-center gap-2">
          {schema.data ? <ColumnPicker schema={schema.data} columns={columns.map((c) => c.key)} onChange={onColumnsChange} /> : null}
          {dirtyRows ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => discard()} disabled={saving}>
                <X /> Discard
              </Button>
              <Button size="sm" onClick={save} disabled={saving}>
                <Save /> {saving ? "Saving…" : `Save ${dirtyRows} ${dirtyRows === 1 ? "row" : "rows"}`}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <div
        ref={(el) => {
          scroller.current = el;
          grid.current = el;
        }}
        className="relative min-h-[320px] flex-1 overflow-auto rounded-md border border-border bg-surface outline-none focus-visible:ring-2 focus-visible:ring-primary"
        style={{ maxHeight: "calc(100vh - 220px)" }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        tabIndex={0}
        role="grid"
        aria-label="Sheet"
        aria-rowcount={total ?? undefined}
        aria-colcount={columns.length}
        onKeyDown={onKeyDown}
        onCopy={(e) => {
          if (!editing) void copySelection(e);
        }}
        onPaste={(e) => {
          if (editing) return;
          e.preventDefault();
          paste(e.clipboardData.getData("text/plain"));
        }}
      >
        <div style={{ width: gridWidth, minWidth: "100%" }}>
          <div className="sticky top-0 z-10 flex border-b border-border bg-bg-subtle text-xs font-semibold text-fg-muted" role="row">
            <div className="w-10 shrink-0 border-r border-border" role="columnheader" aria-label="Open" />
            {columns.map((c, i) => (
              <div key={c.key} role="columnheader" className="flex shrink-0 items-center gap-1 border-r border-border px-2 py-2" style={{ width: widths[i] }} title={c.read_only ? "Read only for you" : undefined}>
                <span className="truncate">{c.label}</span>
                {!canEditInline(c) ? <span className="text-[10px] font-normal text-fg-subtle">{c.read_only ? "read only" : "locked"}</span> : null}
              </div>
            ))}
          </div>
          <div style={{ height: (total ?? 0) * ROW_H, position: "relative" }}>
            {visible.map((r) => {
              const row = rowAt(r);
              const conflict = row ? conflicts.has(row.id) : false;
              return (
                <div key={r} role="row" aria-rowindex={r + 2} className={cn("absolute left-0 flex border-b border-border", conflict && "bg-warning/10")} style={{ top: r * ROW_H, height: ROW_H, width: gridWidth }}>
                  <div className="flex w-10 shrink-0 items-center justify-center border-r border-border">
                    {row ? (
                      conflict ? (
                        <button
                          type="button"
                          className="text-warning"
                          title="Someone else changed this record first, so your edit was not saved. Showing the latest values."
                          onClick={() => discard(row.id)}
                          aria-label="Edit not saved: someone else changed this record. Dismiss"
                        >
                          <RotateCcw className="size-3.5" />
                        </button>
                      ) : (
                        <Link prefetch={false} href={`/${path}/${encodeURIComponent(row.id)}`} className="text-fg-subtle hover:text-primary" aria-label={`Open ${row.title}`}>
                          <ExternalLink className="size-3.5" />
                        </Link>
                      )
                    ) : null}
                  </div>
                  {columns.map((field, c) => {
                    const width = widths[c];
                    if (!row) {
                      return (
                        <div key={field.key} className="shrink-0 border-r border-border px-2 py-2" style={{ width }}>
                          <Skeleton className="h-3 w-3/4" />
                        </div>
                      );
                    }
                    const key = `${row.id}:${field.key}`;
                    const error = errors.get(key);
                    const dirty = pending.get(row.id)?.has(field.key);
                    const selected = inRange(r, c);
                    const isFocus = focus.r === r && focus.c === c;
                    const isEditing = editing?.pos.r === r && editing.pos.c === c;
                    return (
                      <div
                        key={field.key}
                        role="gridcell"
                        aria-selected={selected}
                        aria-invalid={error ? true : undefined}
                        title={error ?? undefined}
                        className={cn(
                          "relative flex shrink-0 items-center border-r border-border text-sm",
                          selected && "bg-primary-soft/40",
                          isFocus && "outline outline-2 -outline-offset-2 outline-primary",
                          dirty && "bg-warning/15",
                          error && "bg-danger/10",
                          !canEditInline(field) && "text-fg-muted",
                        )}
                        style={{ width }}
                        onMouseDown={(e) => {
                          if (isEditing) return;
                          const pos = { r, c };
                          setFocus(pos);
                          if (!e.shiftKey) setAnchor(pos);
                          grid.current?.focus();
                        }}
                        onDoubleClick={() => startEdit({ r, c })}
                      >
                        {isEditing ? (
                          <CellEditor
                            field={field}
                            initial={editing.initial}
                            stageOptions={stageMapFor(row).options}
                            onCancel={() => {
                              setEditing(null);
                              grid.current?.focus();
                            }}
                            onCommit={(text) => {
                              setEditing(null);
                              stage([{ r, c, text }]);
                              grid.current?.focus();
                            }}
                          />
                        ) : (
                          <span className="truncate px-2">{displayText(row, field)}</span>
                        )}
                        {error && !isEditing ? <AlertTriangle className="absolute right-1 top-1 size-3 text-danger" aria-hidden /> : null}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {total === 0 ? <p className="p-6 text-center text-sm text-fg-subtle">No records match.</p> : null}
        </div>
      </div>
    </div>
  );
}
