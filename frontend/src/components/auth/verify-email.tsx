"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { AuthHeading } from "@/components/auth/auth-heading";
import { Button } from "@/components/ui/button";
import { verifyEmail } from "@/lib/api/allauth";
import { errorMessage } from "@/lib/api/problem";
import { queryKeys } from "@/lib/session";

type State = { status: "pending" } | { status: "verified"; authenticated: boolean } | { status: "failed"; message: string };

export function VerifyEmail() {
  const params = useParams<{ key: string }>();
  const queryClient = useQueryClient();
  const [state, setState] = React.useState<State>({ status: "pending" });
  const started = React.useRef(false);

  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    let key = params.key ?? "";
    try {
      key = decodeURIComponent(key);
    } catch {
      /* keep raw key */
    }
    if (!key) {
      setState({ status: "failed", message: "This verification link is incomplete." });
      return;
    }
    verifyEmail(key)
      .then(async (outcome) => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.session });
        setState({ status: "verified", authenticated: outcome.kind === "authenticated" });
      })
      .catch((err: unknown) => setState({ status: "failed", message: errorMessage(err, "This link is invalid or has expired.") }));
  }, [params.key, queryClient]);

  if (state.status === "pending") {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center" role="status">
        <Loader2 className="size-6 animate-spin text-primary" aria-hidden />
        <p className="text-sm text-fg-muted">Verifying your email…</p>
      </div>
    );
  }

  if (state.status === "failed") {
    return (
      <div className="text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-danger-soft text-danger">
          <XCircle className="size-6" aria-hidden />
        </div>
        <AuthHeading title="Verification failed" description={state.message} />
        <Button asChild variant="secondary" className="w-full">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="text-center">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-success-soft text-success">
        <CheckCircle2 className="size-6" aria-hidden />
      </div>
      <AuthHeading title="Email verified" description="Your email address is confirmed." />
      <Button asChild className="w-full">
        <Link href={state.authenticated ? "/dashboard" : "/login"}>{state.authenticated ? "Continue" : "Sign in"}</Link>
      </Button>
    </div>
  );
}
