"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { logout } from "@/lib/api/allauth";
import { setUnauthenticatedHandler } from "@/lib/api/client";
import { bootstrapSession } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/problem";
import type { Session } from "@/lib/api/types";
import { loginUrlFor } from "@/lib/safe-next";
import { queryKeys, useSession } from "@/lib/session";

/**
 * Client-side session gate.
 *
 * True server-side gating is not possible here: the Django session cookie is
 * only visible to the browser and to the backend behind the same-origin
 * proxy, not to the Next.js server. So the session is resolved client-side
 * on mount, a skeleton is rendered until it settles, and unauthenticated
 * visitors are bounced to /login?next=<validated path>.
 *
 * A signed-in session without an active organization is not a setup step
 * the user has to complete: the gate asks the backend to bootstrap it (the
 * server creates the personal workspace if needed and activates a
 * membership) and then renders the CRM. The backend still enforces every
 * permission; this only decides what to render.
 */
export function AuthGate({ children, fallback }: { children: (session: Session) => React.ReactNode; fallback?: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
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
  const needsBootstrap = session.isSuccess && session.data.active === null;

  const bootstrap = useMutation({
    mutationFn: bootstrapSession,
    onSuccess: (data) => queryClient.setQueryData(queryKeys.session, data),
  });
  const { mutate: runBootstrap } = bootstrap;
  const attempted = React.useRef(false);

  React.useEffect(() => {
    if (unauthenticated) router.replace(loginUrlFor(currentPath));
  }, [unauthenticated, router, currentPath]);

  React.useEffect(() => {
    if (needsBootstrap && !attempted.current) {
      attempted.current = true;
      runBootstrap();
    }
  }, [needsBootstrap, runBootstrap]);

  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.clear();
      router.replace("/login");
    },
  });

  if (session.isPending || unauthenticated) {
    return <>{fallback ?? <GateSkeleton />}</>;
  }

  if (session.isError) {
    return (
      <GateMessage title="We couldn't load your session" description={errorMessage(session.error)}>
        <Button variant="secondary" onClick={() => session.refetch()}>
          Try again
        </Button>
      </GateMessage>
    );
  }

  if (session.data.active === null) {
    if (bootstrap.isError) {
      return (
        <GateMessage title="We couldn't open your workspace" description={errorMessage(bootstrap.error)}>
          <Button
            onClick={() => {
              bootstrap.reset();
              runBootstrap();
            }}
          >
            Try again
          </Button>
          <Button variant="ghost" onClick={() => signOut.mutate()} loading={signOut.isPending}>
            Sign out
          </Button>
        </GateMessage>
      );
    }
    if (bootstrap.isSuccess) {
      // The server answered but found nothing to activate: the account has no usable membership
      // (for example every membership was disabled by an administrator).
      return (
        <GateMessage
          title="No workspace available"
          description={`${session.data.user.email} is not an active member of any organization. Ask your administrator to restore your access.`}
        >
          <Button variant="secondary" onClick={() => signOut.mutate()} loading={signOut.isPending}>
            Sign out
          </Button>
        </GateMessage>
      );
    }
    return <>{fallback ?? <GateSkeleton />}</>;
  }

  return <>{children(session.data)}</>;
}

function GateMessage({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
      <p className="text-md font-semibold">{title}</p>
      <p className="max-w-md text-sm text-fg-muted">{description}</p>
      <div className="mt-1 flex items-center gap-2">{children}</div>
    </div>
  );
}

export function GateSkeleton() {
  return (
    <div className="flex min-h-dvh" role="status" aria-label="Loading">
      <div className="hidden w-56 border-r border-border bg-surface p-3 lg:block">
        <Skeleton className="mb-5 h-7 w-24" />
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      </div>
      <div className="flex flex-1 flex-col">
        <div className="flex h-12 items-center gap-3 border-b border-border bg-surface px-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="ml-auto size-7 rounded-full" />
        </div>
        <div className="flex flex-col gap-3 p-5">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </div>
    </div>
  );
}
