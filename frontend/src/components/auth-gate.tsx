"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { setUnauthenticatedHandler } from "@/lib/api/client";
import { errorMessage, isApiError } from "@/lib/api/problem";
import type { Session } from "@/lib/api/types";
import { loginUrlFor } from "@/lib/safe-next";
import { useSession } from "@/lib/session";

/**
 * Client-side session gate.
 *
 * True server-side gating is not possible here: the Django session cookie is
 * only visible to the browser and to the backend behind the same-origin
 * rewrite, not to the Next.js server. So the session is resolved client-side
 * on mount, a skeleton is rendered until it settles, and unauthenticated
 * visitors are bounced to /login?next=<validated path>. The backend still
 * enforces every permission; this only decides what to render.
 */
export function AuthGate({
  children,
  requireOrganization = true,
  fallback,
}: {
  children: (session: Session) => React.ReactNode;
  requireOrganization?: boolean;
  fallback?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const session = useSession();

  const currentPath = React.useMemo(() => {
    const qs = searchParams?.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  }, [pathname, searchParams]);

  // Any API call that discovers the session is gone bounces to login.
  React.useEffect(() => {
    setUnauthenticatedHandler(() => router.replace(loginUrlFor(currentPath)));
    return () => setUnauthenticatedHandler(null);
  }, [router, currentPath]);

  const unauthenticated = session.isError && isApiError(session.error) && session.error.isNotAuthenticated;
  const needsOrganization = requireOrganization && session.isSuccess && session.data.active === null;

  React.useEffect(() => {
    if (unauthenticated) router.replace(loginUrlFor(currentPath));
    else if (needsOrganization) router.replace("/onboarding/create-organization");
  }, [unauthenticated, needsOrganization, router, currentPath]);

  if (session.isPending || unauthenticated || needsOrganization) {
    return <>{fallback ?? <GateSkeleton />}</>;
  }

  if (session.isError) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-md font-semibold">We couldn&apos;t load your session</p>
        <p className="max-w-md text-sm text-fg-muted">{errorMessage(session.error)}</p>
        <Button variant="secondary" onClick={() => session.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  return <>{children(session.data)}</>;
}

export function GateSkeleton() {
  return (
    <div className="flex min-h-dvh" role="status" aria-label="Loading">
      <div className="hidden w-64 border-r border-border bg-surface p-4 lg:block">
        <Skeleton className="mb-6 h-8 w-28" />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      </div>
      <div className="flex flex-1 flex-col">
        <div className="flex h-14 items-center gap-3 border-b border-border bg-surface px-4">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="ml-auto size-8 rounded-full" />
        </div>
        <div className="flex flex-col gap-4 p-6">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    </div>
  );
}
