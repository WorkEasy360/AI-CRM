"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, CalendarCheck, Contact, CornerDownLeft, Handshake, Loader2, Package, Search } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { globalSearch } from "@/lib/api/crm";
import { ENTITY_LABELS, type SearchEntityType, type SearchHit, type SearchResponse } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import type { ActiveContext } from "@/lib/api/types";
import { useDebounced } from "@/lib/crm/use-list-params";
import { hasPermission } from "@/lib/session";
import { cn } from "@/lib/utils";

export const SEARCH_MAX_LENGTH = 200;
export const SEARCH_MIN_LENGTH = 2;
const DEBOUNCE_MS = 250;

/** Result groups in display order: the records a rep looks up most, then the calendar, then the catalogue. */
export const GROUP_ORDER: readonly SearchEntityType[] = ["contact", "company", "deal", "activity", "product"];

const ICONS: Record<SearchEntityType, React.ComponentType<{ className?: string }>> = {
  contact: Contact,
  company: Building2,
  deal: Handshake,
  product: Package,
  activity: CalendarCheck,
};

/** Fixed route builders; the id is the API-provided id, URL-encoded. Activities open in place on the Activities page. */
const ROUTES: Record<SearchEntityType, (id: string) => string> = {
  contact: (id) => `/contacts/${id}`,
  company: (id) => `/companies/${id}`,
  deal: (id) => `/deals/${id}`,
  product: (id) => `/products/${id}`,
  activity: (id) => `/activities?open=${id}`,
};

export function hitHref(type: SearchEntityType, id: string): string {
  return ROUTES[type](encodeURIComponent(id));
}

interface FlatHit {
  type: SearchEntityType;
  hit: SearchHit;
  href: string;
}

interface Group {
  type: SearchEntityType;
  hits: FlatHit[];
}

function toGroups(response: SearchResponse): Group[] {
  const groups: Group[] = [];
  for (const type of GROUP_ORDER) {
    const hits = response.results?.[type];
    if (!Array.isArray(hits) || hits.length === 0) continue;
    groups.push({ type, hits: hits.map((hit) => ({ type, hit, href: hitHref(type, hit.id) })) });
  }
  return groups;
}

function friendlyError(err: unknown): string {
  if (isApiError(err)) {
    if (err.status === 403) return "You don't have permission to search.";
    if (err.status === 429) return "Too many searches in a short time. Try again in a moment.";
  }
  return errorMessage(err, "Search is unavailable right now.");
}

type SearchState =
  | { status: "idle" }
  | { status: "loading"; groups: Group[] }
  | { status: "done"; groups: Group[]; query: string }
  | { status: "error"; message: string };

/**
 * Command-palette style global search (Ctrl/⌘+K). Renders the header triggers and the dialog; the
 * shell owns the `open` state so it can register the keyboard shortcut.
 */
export function GlobalSearch({ active, open, onOpenChange }: { active: ActiveContext; open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const allowed = hasPermission(active, "search.use");
  const [query, setQuery] = React.useState("");
  const debounced = useDebounced(query.trim(), DEBOUNCE_MS);
  const [state, setState] = React.useState<SearchState>({ status: "idle" });
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [isMac, setIsMac] = React.useState(false);
  const listId = React.useId();
  const listRef = React.useRef<HTMLUListElement>(null);

  React.useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/.test(navigator.platform ?? ""));
  }, []);

  const isOpen = open && allowed;

  React.useEffect(() => {
    if (!isOpen) return;
    if (debounced.length < SEARCH_MIN_LENGTH) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState((prev) => ({ status: "loading", groups: "groups" in prev ? prev.groups : [] }));
    globalSearch(debounced, undefined, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setState({ status: "done", groups: toGroups(response), query: debounced });
        setActiveIndex(0);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: friendlyError(err) });
      });
    return () => controller.abort();
  }, [debounced, isOpen]);

  const groups = React.useMemo<Group[]>(() => ("groups" in state ? state.groups : []), [state]);
  const flat = React.useMemo(() => groups.flatMap((g) => g.hits), [groups]);
  const current = flat[activeIndex];

  React.useEffect(() => {
    if (!current) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, current]);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setQuery("");
      setState({ status: "idle" });
      setActiveIndex(0);
    }
    onOpenChange(next);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (flat.length === 0) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, flat.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(flat.length - 1);
        break;
      case "Enter":
        if (current) {
          event.preventDefault();
          handleOpenChange(false);
          router.push(current.href);
        }
        break;
      default:
    }
  };

  const optionId = (index: number) => `${listId}-option-${index}`;

  let body: React.ReactNode;
  if (state.status === "error") {
    body = (
      <p role="alert" className="px-3 py-6 text-center text-sm text-danger">
        {state.message}
      </p>
    );
  } else if (state.status === "idle") {
    body = (
      <p className="px-3 py-6 text-center text-sm text-fg-muted">
        Type at least {SEARCH_MIN_LENGTH} characters to search contacts, companies, deals, activities and products.
      </p>
    );
  } else if (flat.length === 0) {
    body =
      state.status === "loading" ? (
        <p className="px-3 py-6 text-center text-sm text-fg-muted" role="status">
          Searching…
        </p>
      ) : (
        <p className="px-3 py-6 text-center text-sm text-fg-muted" role="status">
          No results for <span className="font-medium text-fg">“{state.query}”</span>.
        </p>
      );
  } else {
    let index = -1;
    body = (
      <ul ref={listRef} id={listId} role="listbox" aria-label="Search results" className={cn("flex flex-col gap-1", state.status === "loading" && "opacity-60")}>
        {groups.map((group) => (
          <li key={group.type} role="presentation">
            <div className="px-2 pb-1 pt-2 text-[12px] font-semibold uppercase tracking-wide text-fg-subtle">{ENTITY_LABELS[group.type].plural}</div>
            <ul role="group" aria-label={ENTITY_LABELS[group.type].plural} className="flex flex-col">
              {group.hits.map((item) => {
                index += 1;
                const i = index;
                const Icon = ICONS[item.type];
                const selected = i === activeIndex;
                return (
                  <li key={`${item.type}-${item.hit.id}`} role="option" aria-selected={selected} id={optionId(i)} data-index={i}>
                    <Link
                      href={item.href}
                      tabIndex={-1}
                      onClick={() => handleOpenChange(false)}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={cn(
                        "flex items-center gap-3 rounded-sm px-2 py-2 text-sm text-fg",
                        selected ? "bg-primary-soft" : "hover:bg-bg-subtle",
                      )}
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-sm bg-bg-subtle text-fg-muted">
                        <Icon className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{item.hit.title}</span>
                        {item.hit.subtitle ? <span className="block truncate text-xs text-fg-muted">{item.hit.subtitle}</span> : null}
                      </span>
                      {item.hit.meta ? <span className="hidden shrink-0 text-xs text-fg-subtle sm:block">{item.hit.meta}</span> : null}
                      {selected ? <CornerDownLeft className="size-3.5 shrink-0 text-fg-subtle" aria-hidden /> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <>
      {/* Below `md` the bottom tab bar owns the Search entry point. */}
      {allowed ? (
        <button
          type="button"
          onClick={() => handleOpenChange(true)}
          className="hidden h-9 w-72 items-center gap-2 rounded-sm border border-border-strong bg-bg px-3 text-sm text-fg-subtle hover:bg-bg-subtle md:flex"
          aria-label="Search"
          aria-keyshortcuts="Control+K Meta+K"
        >
          <Search className="size-4" aria-hidden />
          <span className="flex-1 text-left">Search…</span>
          <kbd className="rounded-sm border border-border bg-surface px-1.5 font-mono text-[11px] text-fg-subtle">{isMac ? "⌘ K" : "Ctrl K"}</kbd>
        </button>
      ) : null}

      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent hideClose className="top-[10%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0 sm:top-[15%]">
          <DialogTitle className="sr-only">Search</DialogTitle>
          <DialogDescription className="sr-only">Search contacts, companies, deals, activities and products. Use the arrow keys to move and Enter to open.</DialogDescription>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 shrink-0 text-fg-subtle" aria-hidden />
            <input
              type="text"
              role="combobox"
              aria-label="Search"
              aria-expanded={flat.length > 0}
              aria-controls={listId}
              aria-activedescendant={current ? optionId(activeIndex) : undefined}
              aria-autocomplete="list"
              autoComplete="off"
              autoFocus
              spellCheck={false}
              maxLength={SEARCH_MAX_LENGTH}
              placeholder="Search contacts, companies, deals, activities…"
              value={query}
              onChange={(e) => setQuery(e.target.value.slice(0, SEARCH_MAX_LENGTH))}
              onKeyDown={onKeyDown}
              className="h-12 min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
            />
            {state.status === "loading" ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-fg-subtle" aria-label="Searching" />
            ) : (
              <kbd className="hidden rounded-sm border border-border bg-surface px-1.5 font-mono text-[11px] text-fg-subtle sm:block">Esc</kbd>
            )}
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-2">{body}</div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-2 text-[12px] text-fg-subtle">
            <span>
              <kbd className="font-mono">↑</kbd> <kbd className="font-mono">↓</kbd> to move
            </span>
            <span>
              <kbd className="font-mono">↵</kbd> to open
            </span>
            <span>
              <kbd className="font-mono">Esc</kbd> to close
            </span>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
