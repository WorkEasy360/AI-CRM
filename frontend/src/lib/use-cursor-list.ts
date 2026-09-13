"use client";

import { useInfiniteQuery, type QueryKey } from "@tanstack/react-query";
import { cursorFromUrl } from "@/lib/api/client";
import type { Paginated } from "@/lib/api/types";

/** Cursor-paginated list backed by useInfiniteQuery, with a flat `items` array. */
export function useCursorList<T>(queryKey: QueryKey, fetchPage: (cursor: string | null) => Promise<Paginated<T>>, enabled = true) {
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => cursorFromUrl(last.next),
    enabled,
  });
  const items: T[] = query.data?.pages.flatMap((p) => p.results) ?? [];
  return {
    items,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    hasMore: Boolean(query.hasNextPage),
    loadMore: () => query.fetchNextPage(),
    isLoadingMore: query.isFetchingNextPage,
    refetch: query.refetch,
  };
}
