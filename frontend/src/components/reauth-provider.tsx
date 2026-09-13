"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormError } from "@/components/ui/form-field";
import { reauthenticate } from "@/lib/api/allauth";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { queryKeys } from "@/lib/session";

export class ReauthCancelledError extends Error {
  constructor() {
    super("Re-authentication cancelled");
    this.name = "ReauthCancelledError";
  }
}

interface ReauthContextValue {
  /**
   * Run a sensitive operation. If the API answers `reauth_required`, a
   * password dialog opens; on success the operation is retried once.
   */
  runSensitive: <T>(operation: () => Promise<T>) => Promise<T>;
}

const ReauthContext = React.createContext<ReauthContextValue | null>(null);

interface PendingRequest {
  resolve: () => void;
  reject: (error: Error) => void;
}

export function ReauthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [pending, setPending] = React.useState<PendingRequest | null>(null);
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const requestReauth = React.useCallback(() => {
    return new Promise<void>((resolve, reject) => {
      setPassword("");
      setError(null);
      setPending({ resolve, reject });
    });
  }, []);

  const runSensitive = React.useCallback(
    async <T,>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await operation();
      } catch (err) {
        if (!(isApiError(err) && err.isReauthRequired)) throw err;
        await requestReauth();
        return await operation();
      }
    },
    [requestReauth],
  );

  const close = (cancelled: boolean) => {
    const current = pending;
    setPending(null);
    setPassword("");
    setError(null);
    if (cancelled) current?.reject(new ReauthCancelledError());
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!password) {
      setError("Enter your password to continue.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await reauthenticate(password);
      await queryClient.invalidateQueries({ queryKey: queryKeys.session });
      const current = pending;
      setPending(null);
      setPassword("");
      current?.resolve();
    } catch (err) {
      setError(errorMessage(err, "Could not confirm your password."));
    } finally {
      setSubmitting(false);
    }
  };

  const value = React.useMemo(() => ({ runSensitive }), [runSensitive]);

  return (
    <ReauthContext.Provider value={value}>
      {children}
      <Dialog open={pending !== null} onOpenChange={(open) => !open && close(true)}>
        <DialogContent className="max-w-md">
          <form onSubmit={submit} className="grid gap-4">
            <DialogHeader>
              <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-primary-soft text-primary">
                <ShieldCheck className="size-5" aria-hidden />
              </div>
              <DialogTitle>Confirm it&apos;s you</DialogTitle>
              <DialogDescription>
                This action is sensitive. Re-enter your password to continue; you won&apos;t be asked again for a few minutes.
              </DialogDescription>
            </DialogHeader>
            <FormError message={error} />
            <div className="grid gap-1.5">
              <Label htmlFor="reauth-password">Password</Label>
              <Input
                id="reauth-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => close(true)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" loading={submitting}>
                Confirm
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </ReauthContext.Provider>
  );
}

export function useReauth(): ReauthContextValue {
  const ctx = React.useContext(ReauthContext);
  if (!ctx) throw new Error("useReauth must be used within <ReauthProvider>");
  return ctx;
}

export function isReauthCancelled(error: unknown): boolean {
  return error instanceof ReauthCancelledError;
}
