"use client";

import * as React from "react";
import { keepPreviousData, useInfiniteQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { cursorFromUrl } from "@/lib/api/client";
import type { Paginated } from "@/lib/api/types";

export interface CursorListOptions<T> {
  /**
   * Query key under which one list item should be cached as a detail record. List and detail
   * endpoints return the same shape, so every loaded row seeds the record cache: opening a row
   * renders instantly from cache and only refreshes in the background.
   */
  recordKey?: (item: T) => QueryKey;
}

/**
 * Cursor-paginated list backed by useInfiniteQuery, with a flat `items` array.
 *
 * When the key changes (search, sort, filters) the previous rows stay on screen, marked
 * `isPlaceholderData`, until the new page arrives, instead of flashing a skeleton on every keystroke.
 */
export function useCursorList<T>(
  queryKey: QueryKey,
  fetchPage: (cursor: string | null) => Promise<Paginated<T>>,
  enabled = true,
  options: CursorListOptions<T> = {},
) {
  const queryClient = useQueryClient();
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => cursorFromUrl(last.next),
    enabled,
    placeholderData: keepPreviousData,
  });
  const items = React.useMemo<T[]>(() => query.data?.pages.flatMap((p) => p.results) ?? [], [query.data]);

  const { recordKey } = options;
  const { data, dataUpdatedAt, isPlaceholderData } = query;
  React.useEffect(() => {
    if (!recordKey || !data || isPlaceholderData) return;
    for (const page of data.pages) {
      for (const item of page.results) {
        const key = recordKey(item);
        const existing = queryClient.getQueryState(key)?.dataUpdatedAt ?? 0;
        if (existing < dataUpdatedAt) queryClient.setQueryData(key, item, { updatedAt: dataUpdatedAt });
      }
    }
  }, [data, dataUpdatedAt, isPlaceholderData, recordKey, queryClient]);

  return {
    items,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    /** Previous rows are shown while a changed query loads. */
    isPlaceholderData: query.isPlaceholderData,
    hasMore: Boolean(query.hasNextPage),
    loadMore: () => query.fetchNextPage(),
    isLoadingMore: query.isFetchingNextPage,
    refetch: query.refetch,
  };
}
