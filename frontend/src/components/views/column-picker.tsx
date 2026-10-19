"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Columns3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ModuleSchema } from "@/lib/api/crm-types";

/** Choose and order the columns of a view from the module schema (hidden fields are never offered). */
export function ColumnPicker({
  schema,
  columns,
  onChange,
  available,
}: {
  schema: ModuleSchema;
  columns: string[];
  onChange: (columns: string[]) => void;
  /** Restrict the choice (the List view offers only the columns it knows how to render). */
  available?: string[];
}) {
  const fields = schema.fields.filter((f) => !available || available.includes(f.key));
  const toggle = (key: string) => onChange(columns.includes(key) ? columns.filter((k) => k !== key) : [...columns, key]);
  const shift = (key: string, by: number) => {
    const i = columns.indexOf(key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= columns.length) return;
    const next = [...columns];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" className="h-8">
          <Columns3 /> Columns
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-96 w-64 overflow-y-auto">
        <DropdownMenuLabel>Columns</DropdownMenuLabel>
        <ul className="flex flex-col">
          {fields.map((f) => {
            const on = columns.includes(f.key);
            return (
              <li key={f.key} className="flex items-center gap-1 px-1">
                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-sm hover:bg-bg-subtle">
                  <input type="checkbox" checked={on} onChange={() => toggle(f.key)} />
                  <span className="truncate">{f.label}</span>
                  {f.custom ? <span className="text-[10px] text-fg-subtle">custom</span> : null}
                </label>
                {on ? (
                  <span className="flex shrink-0">
                    <button type="button" className="rounded-sm p-0.5 text-fg-subtle hover:text-fg" aria-label={`Move ${f.label} left`} onClick={() => shift(f.key, -1)}>
                      <ArrowUp className="size-3" />
                    </button>
                    <button type="button" className="rounded-sm p-0.5 text-fg-subtle hover:text-fg" aria-label={`Move ${f.label} right`} onClick={() => shift(f.key, 1)}>
                      <ArrowDown className="size-3" />
                    </button>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
