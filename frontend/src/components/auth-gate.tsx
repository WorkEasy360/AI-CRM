"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { logout } from "@/lib/api/allauth";
import { setAccessEndedHandler, setUnauthenticatedHandler } from "@/lib/api/client";
import { bootstrapSession, switchOrganization } from "@/lib/api/endpoints";
import { errorMessage, isApiError, PROBLEM_TYPES } from "@/lib/api/problem";
import type { Session } from "@/lib/api/types";
import { useAuthMethods, workeasy360StartUrl } from "@/lib/auth-methods";
import { claimAutoStart, clearAutoStartGuard } from "@/lib/direct-sign-in";
import { replaceLocation } from "@/lib/external-navigation";
import { loginUrlFor } from "@/lib/safe-next";
import { queryKeys, useSession } from "@/lib/session";

/** How long the start of a Workeasy360 sign-in may take before the person is offered a way on. */
const STARTING_TAKES_LONG_MS = 5000;

/**
 * Client-side session gate.
 *
 * True server-side gating is not possible here: the Django session cookie is
 * only visible to the browser and to the backend behind the same-origin
 * proxy, not to the Next.js server. So the session is resolved client-side
 * on mount and a skeleton is rendered until it settles. A visitor without a
 * session is sent to /login?next=<validated path>. (With the development
 * auto-login the backend opens a session on the first request, so this
 * redirect never fires there.) Any other failure to load the session shows a
 * retryable message.
 *
 * When Workeasy360 is the only sign-in (the server offers no password), that visitor is not sent
 * to a sign-in page they would only click through: the gate starts the Workeasy360 sign-in itself,
 * for the page they asked for, so someone already signed in to Workeasy360 arrives signed in. It
 * never does that after a sign-out here, or when this browser started one less than a minute ago
 * and still has no session (lib/direct-sign-in.ts); those visitors see the sign-in page. Only this
 * gate does it: API calls still answer 401, and a session whose access ended keeps its explanation.
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

  // Any API call that discovers the session is gone re-resolves it; if the session really is gone
  // that refetch fails as not-authenticated and the effect below sends the visitor to sign in.
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

  // Workeasy360 says the organization's access to WorkEasy CRM has ended (its entitlement re-check, enforced
  // by the API). Any call can discover it; one explanation replaces the CRM instead of an error on every
  // page. The session itself is fine, so signing out stays possible.
  // The same screen explains "sign in with Workeasy360" (a session that never came from it, in a deployment
  // where it is the only way in): signing in links the account, after which access is checked per person.
  const [accessEnded, setAccessEnded] = React.useState<{
    title: string;
    message: string;
    signInRequired: boolean;
  } | null>(null);
  React.useEffect(() => {
    setAccessEndedHandler((error) =>
      setAccessEnded({
        title:
          error.type === PROBLEM_TYPES.signInRequired
            ? "Sign in with Workeasy360"
            : error.type === PROBLEM_TYPES.accessUnverified
              ? "WorkEasy CRM can't confirm your access"
              : "WorkEasy CRM access has ended",
        message: error.message,
        signInRequired: error.type === PROBLEM_TYPES.signInRequired,
      }),
    );
    return () => setAccessEndedHandler(null);
  }, []);

  // Whether that re-resolve found a session. React Query keeps a query in the "success" state when a
  // *refetch* fails but earlier data is still cached, so `isError` alone never fires here and the gate
  // would keep rendering the CRM shell for a session the server has already revoked. The failed
  // attempt is still reported, as `failureReason`, which is what this reads.
  //
  // Deliberately scoped to this query's own failure rather than to "any 401 the app saw": one
  // endpoint answering 403 for its own reasons must not tear the whole shell down.
  const sessionGone =
    session.isError || (isApiError(session.failureReason) && session.failureReason.isNotAuthenticated);
  const sessionError = session.error ?? session.failureReason;
  // Signed out (never signed in, expired or revoked), as opposed to the session endpoint failing.
  const signedOut = sessionGone && isApiError(sessionError) && sessionError.isNotAuthenticated;

  // Whether Workeasy360 is the only sign-in here: the server offers no password and does offer Workeasy360.
  // Asked of the server rather than assumed; until it answers nothing is decided, and if it cannot be
  // asked the visitor gets the sign-in page, which falls back to the password form.
  const methods = useAuthMethods();
  const workeasy360Only = Boolean(methods.data && !methods.data.password && methods.data.workeasy360);
  const [startingSignIn, setStartingSignIn] = React.useState(false);
  const [startingTakesLong, setStartingTakesLong] = React.useState(false);
  // Bumped when the browser brings this page back from its back/forward cache, to decide again.
  const [restores, setRestores] = React.useState(0);
  const signedOutHandled = React.useRef(false);
  const { isPending: methodsPending } = methods;

  React.useEffect(() => {
    if (!signedOut) {
      signedOutHandled.current = false;
      return;
    }
    if (methodsPending || signedOutHandled.current) return;
    signedOutHandled.current = true;
    if (workeasy360Only && claimAutoStart()) {
      setStartingSignIn(true);
      replaceLocation(workeasy360StartUrl(currentPath));
      return;
    }
    router.replace(loginUrlFor(currentPath));
  }, [signedOut, methodsPending, workeasy360Only, router, currentPath, restores]);

  // While the start is under way: say so if it takes long, and start over if the browser restores this page
  // from its back/forward cache (the person came back from Workeasy360; the page would otherwise sit on
  // "Signing you in" for ever). Deciding again goes through the loop guard, so a restore soon after a start
  // gets the sign-in page rather than another start.
  React.useEffect(() => {
    if (!startingSignIn) return;
    const timer = window.setTimeout(() => setStartingTakesLong(true), STARTING_TAKES_LONG_MS);
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      signedOutHandled.current = false;
      setStartingSignIn(false);
      setStartingTakesLong(false);
      setRestores((n) => n + 1);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [startingSignIn]);

  // A session exists, so a sign-in started earlier did what it was for: the loop guard is spent.
  const hasSession = session.isSuccess;
  React.useEffect(() => {
    if (hasSession) clearAutoStartGuard();
  }, [hasSession]);

  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.clear();
      router.replace("/login");
    },
  });

  // Access can end for one organization only; the person may belong to others (the switch endpoint is exempt
  // from the entitlement check), so the "access has ended" screen offers them.
  const switchOrg = useMutation({
    mutationFn: switchOrganization,
    onSuccess: async () => {
      setAccessEnded(null);
      await queryClient.invalidateQueries();
    },
  });

  const retryAccess = () => {
    setAccessEnded(null);
    void queryClient.invalidateQueries();
  };

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

  if (session.isPending || signedOut || startingSignIn) {
    // One status region for the whole wait, there from the first render so that screen readers announce
    // each change of its text (a region inserted together with its text is often not announced).
    const status = !startingSignIn
      ? "Loading"
      : startingTakesLong
        ? "Signing in with Workeasy360 is taking longer than expected."
        : "Signing you in with Workeasy360…";
    return (
      <>
        <div role="status" className="sr-only">
          {status}
        </div>
        {startingSignIn ? (
          <StartingSignIn
            takesLong={startingTakesLong}
            startHref={workeasy360StartUrl(currentPath)}
            loginHref={loginUrlFor(currentPath)}
          />
        ) : (
          (fallback ?? <GateSkeleton announce={false} />)
        )}
      </>
    );
  }

  if (sessionGone) {
    return (
      <GateMessage title="We couldn't load your session" description={errorMessage(sessionError)}>
        <Button variant="secondary" onClick={() => session.refetch()}>
          Try again
        </Button>
      </GateMessage>
    );
  }

  if (accessEnded) {
    const otherOrganizations = session.data.memberships.filter(
      (m) => m.status === "active" && m.id !== session.data.active?.membership_id,
    );
    return (
      <GateMessage
        title={accessEnded.title}
        description={switchOrg.isError ? `${accessEnded.message} ${errorMessage(switchOrg.error)}` : accessEnded.message}
      >
        {accessEnded.signInRequired ? (
          <Button asChild>
            <a href={workeasy360StartUrl(currentPath)}>Sign in with Workeasy360</a>
          </Button>
        ) : (
          <Button variant="secondary" onClick={retryAccess}>
            Try again
          </Button>
        )}
        {otherOrganizations.map((m) => (
          <Button
            key={m.id}
            variant="secondary"
            onClick={() => switchOrg.mutate(m.id)}
            loading={switchOrg.isPending && switchOrg.variables === m.id}
          >
            Switch to {m.organization.name}
          </Button>
        ))}
        <Button variant="ghost" onClick={() => signOut.mutate()} loading={signOut.isPending}>
          Sign out
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
      {/* The whole page is this message, so its title is the page's heading. */}
      <h1 className="text-md font-semibold">{title}</h1>
      <p className="max-w-md text-sm text-fg-muted">{description}</p>
      <div className="mt-1 flex items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * Shown for the moment between deciding to start the Workeasy360 sign-in and the browser leaving. If it
 * is still here after a few seconds something is wrong (or the person came back), so two ways on appear.
 */
function StartingSignIn({ takesLong, startHref, loginHref }: { takesLong: boolean; startHref: string; loginHref: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-md font-semibold">Signing you in with Workeasy360…</h1>
      {takesLong ? (
        <>
          <p className="max-w-md text-sm text-fg-muted">This is taking longer than expected.</p>
          <div className="mt-1 flex items-center gap-2">
            <Button asChild>
              <a href={startHref}>Continue with Workeasy360</a>
            </Button>
            <Button asChild variant="secondary">
              <a href={loginHref}>Go to the sign-in page</a>
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** `announce` false: the caller already has a status region for this wait (see AuthGate). */
export function GateSkeleton({ announce = true }: { announce?: boolean } = {}) {
  return (
    <div className="flex min-h-dvh" {...(announce ? { role: "status", "aria-label": "Loading" } : {})}>
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
