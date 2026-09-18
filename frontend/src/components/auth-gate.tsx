"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { setUnauthenticatedHandler } from "@/lib/api/client";
import { bootstrapSession } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/problem";
import type { Session } from "@/lib/api/types";
import { queryKeys, useSession } from "@/lib/session";

/**
 * Client-side session gate.
 *
 * There is no sign-in page: the backend opens the session itself, so this
 * only resolves it. The Django session cookie is visible to the browser and
 * to the backend behind the same-origin proxy but not to the Next.js server,
 * so the session is still fetched client-side on mount and a skeleton is
 * rendered until it settles. When the session turns out to be missing there
 * is nowhere to bounce to, so it is refetched (the backend opens a new one)
 * and a retryable message is shown if that fails too.
 *
 * A signed-in session without an active organization is not a setup step
 * the user has to complete: the gate asks the backend to bootstrap it (the
 * server creates the personal workspace if needed and activates a
 * membership) and then renders the CRM. The backend still enforces every
 * permission; this only decides what to render.
 */
export function AuthGate({ children, fallback }: { children: (session: Session) => React.ReactNode; fallback?: React.ReactNode }) {
  const queryClient = useQueryClient();
  const session = useSession();

  // Any API call that discovers the session is gone re-resolves it instead of redirecting.
  //
  // The re-entrancy guard is what makes that terminate. The re-resolve is itself an API call, so when
  // the session really is gone it answers 401 and lands back in this handler; without the guard each
  // failure schedules the next refetch, the query never settles, and the gate renders the stale
  // session forever instead of reporting that it is gone.
  const resolving = React.useRef(false);
  React.useEffect(() => {
    setUnauthenticatedHandler(() => {
      if (resolving.current) return;
      resolving.current = true;
      void queryClient.invalidateQueries({ queryKey: queryKeys.session }).finally(() => {
        resolving.current = false;
      });
    });
    return () => setUnauthenticatedHandler(null);
  }, [queryClient]);

  // Whether that re-resolve found a session. React Query keeps a query in the "success" state when a
  // *refetch* fails but earlier data is still cached, so `isError` alone never fires here and the gate
  // would keep rendering the CRM shell for a session the server has already revoked. The failed
  // attempt is still reported, as `failureReason`, which is what this reads.
  //
  // Deliberately scoped to this query's own failure rather than to "any 401 the app saw": one
  // endpoint answering 403 for its own reasons must not tear the whole shell down.
  const sessionGone =
    session.isError || (isApiError(session.failureReason) && session.failureReason.isNotAuthenticated);

  const needsBootstrap = session.isSuccess && session.data.active === null;

  const bootstrap = useMutation({
    mutationFn: bootstrapSession,
    onSuccess: (data) => queryClient.setQueryData(queryKeys.session, data),
  });
  const { mutate: runBootstrap } = bootstrap;
  const attempted = React.useRef(false);

  React.useEffect(() => {
    if (needsBootstrap && !attempted.current) {
      attempted.current = true;
      runBootstrap();
    }
  }, [needsBootstrap, runBootstrap]);

  if (session.isPending) {
    return <>{fallback ?? <GateSkeleton />}</>;
  }

  if (sessionGone) {
    return (
      <GateMessage title="We couldn't load your session" description={errorMessage(session.error ?? session.failureReason)}>
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
          <Button variant="secondary" onClick={() => session.refetch()}>
            Try again
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
