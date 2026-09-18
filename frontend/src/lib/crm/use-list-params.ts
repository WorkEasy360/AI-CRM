"use client";

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type { ListParams } from "@/lib/api/crm-types";

/**
 * Rewrites the query string through the History API rather than `router.replace`. Every route renders
 * dynamically (per-request CSP nonce, see app/layout.tsx), so `router.replace` fetched a fresh server
 * payload for the page and `useSearchParams` only changed once it arrived: each filter, sort, tab or
 * search waited one server round trip before its API request could even start. Next.js keeps
 * `usePathname`/`useSearchParams` in sync with native `replaceState` without contacting the server,
 * and the page's data is fetched client-side anyway. Like `{ scroll: false }`, it never scrolls.
 */
function replaceUrl(url: string) {
  window.history.replaceState(null, "", url);
}

/**
 * List state (search, sort, filters, archived) kept in the URL so views are shareable and survive
 * navigation. Only the keys named in `allowed` are read from the URL; anything else is ignored.
 */
export function useListParams(allowed: readonly string[], defaults: ListParams = {}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const params = React.useMemo<ListParams>(() => {
    const out: ListParams = { ...defaults };
    for (const key of allowed) {
      const value = searchParams?.get(key);
      if (value !== null && value !== undefined && value !== "") out[key] = value;
    }
    for (const [key, value] of searchParams?.entries() ?? []) {
      if (key.startsWith("custom.") && value) out[key] = value;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, allowed.join("|"), JSON.stringify(defaults)]);

  const setParams = React.useCallback(
    (patch: ListParams) => {
      const next = new URLSearchParams(searchParams?.toString() ?? "");
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === "" || value === null) next.delete(key);
        else next.set(key, value);
      }
      const qs = next.toString();
      replaceUrl(qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname, searchParams],
  );

  const setParam = React.useCallback((key: string, value: string | undefined) => setParams({ [key]: value }), [setParams]);

  const clear = React.useCallback(() => replaceUrl(pathname), [pathname]);

  const activeFilterCount = Object.keys(params).filter((k) => !["sort", "q"].includes(k) && params[k] !== defaults[k]).length;

  return { params, setParam, setParams, clear, activeFilterCount };
}

/** Debounce a changing value (used for search-as-you-type). */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}
