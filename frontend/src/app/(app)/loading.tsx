import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";

/**
 * Route-level loading boundary inside the app shell. Every route renders dynamically (per-request CSP
 * nonce), so without it a sidebar click kept the previous page on screen, with no feedback, until the
 * next page's server payload arrived. With it, link prefetching stops at this boundary and the
 * skeleton paints immediately while the shell (nav, header, session) stays mounted.
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-8 w-48" />
      <SkeletonRows rows={6} />
    </div>
  );
}
