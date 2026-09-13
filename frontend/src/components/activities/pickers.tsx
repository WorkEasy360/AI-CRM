"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { listCompanies, listContacts, listDeals } from "@/lib/api/crm";
import type { MembershipRef, NamedRef, RelatedEntityType } from "@/lib/api/crm-types";
import { listMembers } from "@/lib/api/endpoints";
import { useDebounced } from "@/lib/crm/use-list-params";
import { queryKeys } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { cn } from "@/lib/utils";

const LABELS: Record<RelatedEntityType, string> = { contact: "Contact", company: "Company", deal: "Deal" };

async function search(entity: RelatedEntityType, q: string): Promise<NamedRef[]> {
  const params = { sort: "name", q: q || undefined };
  if (entity === "contact") return (await listContacts(params)).results.map((c) => ({ id: c.id, name: c.display_name || c.email }));
  if (entity === "company") return (await listCompanies(params)).results.map((c) => ({ id: c.id, name: c.name }));
  return (await listDeals(params)).results.map((d) => ({ id: d.id, name: d.name }));
}

/** Compact chip for a selected record with a clear button. */
export function RecordChip({ name, onClear, disabled, label }: { name: string; onClear?: () => void; disabled?: boolean; label?: string }) {
  return (
    <span className="inline-flex h-8 max-w-full items-center gap-1 rounded-sm border border-border bg-bg-subtle pl-2 pr-1 text-sm">
      {label ? <span className="text-xs text-fg-subtle">{label}:</span> : null}
      <span className="truncate">{name}</span>
      {onClear ? (
        <button
          type="button"
          onClick={onClear}
          disabled={disabled}
          aria-label={`Remove ${name}`}
          className="rounded-sm p-0.5 text-fg-subtle hover:bg-surface hover:text-fg disabled:opacity-50"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </span>
  );
}

/**
 * Searchable single-record picker (contact / company / deal). Renders the chosen record as a chip;
 * otherwise a combobox that searches by name as you type. Keyboard: arrows, Enter, Escape.
 */
export function RecordPicker({
  id,
  entity,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  id?: string;
  entity: RelatedEntityType;
  value: NamedRef | null;
  onChange: (next: NamedRef | null) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [highlight, setHighlight] = React.useState(0);
  const debounced = useDebounced(query, 250);
  const listId = React.useId();

  const results = useQuery({
    queryKey: ["crm", "picker", entity, debounced],
    queryFn: () => search(entity, debounced),
    enabled: open && !disabled,
    staleTime: 60_000,
  });
  const options = results.data ?? [];

  React.useEffect(() => setHighlight(0), [options.length, debounced]);

  const choose = (option: NamedRef) => {
    onChange(option);
    setQuery("");
    setOpen(false);
  };

  if (value) return <RecordChip name={value.name} onClear={disabled ? undefined : () => onChange(null)} disabled={disabled} />;

  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && options[highlight] ? `${listId}-${options[highlight].id}` : undefined}
        placeholder={placeholder ?? `Search ${LABELS[entity].toLowerCase()}s…`}
        value={query}
        disabled={disabled}
        autoComplete="off"
        className="h-8"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setHighlight((h) => Math.min(h + 1, Math.max(0, options.length - 1)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter" && open && options[highlight]) {
            e.preventDefault();
            choose(options[highlight]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={`${LABELS[entity]} results`}
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-surface-raised p-1 shadow-md"
        >
          {results.isPending ? (
            <li className="flex items-center gap-2 px-2 py-1.5 text-xs text-fg-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Searching…
            </li>
          ) : results.isError ? (
            <li className="px-2 py-1.5 text-xs text-danger">Could not load {LABELS[entity].toLowerCase()}s. Try again.</li>
          ) : options.length === 0 ? (
            <li className="px-2 py-1.5 text-xs text-fg-subtle">No {LABELS[entity].toLowerCase()}s match.</li>
          ) : (
            options.map((option, i) => (
              <li
                key={option.id}
                id={`${listId}-${option.id}`}
                role="option"
                aria-selected={i === highlight}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(option)}
                onMouseEnter={() => setHighlight(i)}
                className={cn("cursor-default truncate rounded-sm px-2 py-1.5 text-sm", i === highlight && "bg-bg-subtle")}
              >
                {option.name}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

/** Attendee picker: chips for chosen members plus a select to add another active member. */
export function MemberMultiSelect({
  id,
  value,
  onChange,
  disabled,
}: {
  id?: string;
  value: MembershipRef[];
  onChange: (next: MembershipRef[]) => void;
  disabled?: boolean;
}) {
  const members = useCursorList(queryKeys.members, listMembers);
  const available = members.items.filter((m) => m.status === "active" && !value.some((v) => v.id === m.id));
  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((m) => (
            <RecordChip key={m.id} name={m.display_name} disabled={disabled} onClear={() => onChange(value.filter((v) => v.id !== m.id))} />
          ))}
        </div>
      ) : null}
      <Select
        value=""
        onValueChange={(memberId) => {
          const m = members.items.find((x) => x.id === memberId);
          if (m) onChange([...value, { id: m.id, display_name: m.user.display_name || m.user.email }]);
        }}
        disabled={disabled || members.isPending || available.length === 0}
      >
        <SelectTrigger id={id} aria-label="Add attendee" className="h-8">
          <SelectValue placeholder={members.isPending ? "Loading…" : available.length === 0 ? "No more members" : "Add attendee…"} />
        </SelectTrigger>
        <SelectContent>
          {available.map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {m.user.display_name || m.user.email}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
