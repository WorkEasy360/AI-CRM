"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Copy, KeyRound, MonitorSmartphone, ShieldCheck, ShieldOff } from "lucide-react";
import { z } from "zod";
import { PageHeader } from "@/components/page-header";
import { isReauthCancelled, useReauth } from "@/components/reauth-provider";
import { TotpQr } from "@/components/settings/totp-qr";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import {
  activateTotp,
  changePassword,
  deactivateTotp,
  deleteSessions,
  getRecoveryCodes,
  getTotp,
  listAuthenticators,
  listSessions,
  regenerateRecoveryCodes,
  type RecoveryCodes,
  type TotpStatus,
} from "@/lib/api/allauth";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { queryKeys, useSession } from "@/lib/session";
import { formatDateTime } from "@/lib/utils";
import { passwordSchema, totpCodeSchema } from "@/lib/validation";

export function SecurityPage() {
  return (
    <div className="grid max-w-3xl gap-6">
      <PageHeader title="Security" description="Password, two-factor authentication and active sessions for your account." className="mb-0" />
      <ChangePasswordCard />
      <MfaCard />
      <SessionsCard />
    </div>
  );
}

/* Change password */
const passwordFormSchema = z
  .object({ current_password: z.string().min(1, "Enter your current password."), new_password: passwordSchema, confirm: z.string() })
  .refine((v) => v.new_password === v.confirm, { path: ["confirm"], message: "Passwords do not match." });
type PasswordInput = z.infer<typeof passwordFormSchema>;

function ChangePasswordCard() {
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const form = useForm<PasswordInput>({
    resolver: zodResolver(passwordFormSchema),
    defaultValues: { current_password: "", new_password: "", confirm: "" },
  });

  const mutation = useMutation({
    mutationFn: (v: PasswordInput) => runSensitive(() => changePassword({ current_password: v.current_password, new_password: v.new_password })),
    onSuccess: () => {
      toast({ tone: "success", title: "Password changed" });
      form.reset();
    },
    onError: (err) => {
      if (isReauthCancelled(err)) return;
      if (isApiError(err) && err.isValidation) setFieldErrors(err.fieldErrors());
      else toast({ tone: "error", title: "Could not change password", description: errorMessage(err) });
    },
  });

  return (
    <Card>
      <form
        onSubmit={form.handleSubmit((v) => {
          setFieldErrors({});
          mutation.mutate(v);
        })}
        noValidate
      >
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" aria-hidden /> Password
          </CardTitle>
          <CardDescription>Choose a strong password you do not use anywhere else.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <FormError message={fieldErrors.non_field_errors} />
          <FormField control={form.control} name="current_password" label="Current password" serverError={fieldErrors.current_password}>
            {(field) => <Input {...field} type="password" autoComplete="current-password" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField control={form.control} name="new_password" label="New password" serverError={fieldErrors.new_password}>
              {(field) => <Input {...field} type="password" autoComplete="new-password" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
            </FormField>
            <FormField control={form.control} name="confirm" label="Confirm new password">
              {(field) => <Input {...field} type="password" autoComplete="new-password" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
            </FormField>
          </div>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" loading={mutation.isPending}>
            Update password
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

/* MFA */
const codeSchema = z.object({ code: totpCodeSchema });
type CodeInput = z.infer<typeof codeSchema>;

function MfaCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  const { data: session } = useSession();

  const authenticators = useQuery({ queryKey: queryKeys.authenticators, queryFn: listAuthenticators });
  const totpActive = authenticators.data?.some((a) => a.type === "totp") ?? session?.mfa_enabled ?? false;
  const recoveryMeta = authenticators.data?.find((a) => a.type === "recovery_codes");

  const [setup, setSetup] = React.useState<Extract<TotpStatus, { active: false }> | null>(null);
  const [codes, setCodes] = React.useState<RecoveryCodes | null>(null);
  const [confirmDisable, setConfirmDisable] = React.useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = React.useState(false);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.authenticators }),
      queryClient.invalidateQueries({ queryKey: queryKeys.session }),
    ]);

  const fail = (title: string) => (err: unknown) => {
    if (isReauthCancelled(err)) return;
    toast({ tone: "error", title, description: errorMessage(err) });
  };

  const beginSetup = useMutation({
    mutationFn: () => runSensitive(getTotp),
    onSuccess: (status) => {
      if (status.active) {
        void refresh();
        return;
      }
      if (!status.secret) {
        toast({ tone: "error", title: "Could not start setup", description: "The server did not return a TOTP secret." });
        return;
      }
      setSetup(status);
    },
    onError: fail("Could not start setup"),
  });

  const codeForm = useForm<CodeInput>({ resolver: zodResolver(codeSchema), defaultValues: { code: "" } });
  const [codeError, setCodeError] = React.useState<string | null>(null);

  const activate = useMutation({
    mutationFn: (v: CodeInput) => runSensitive(() => activateTotp(v.code)),
    onSuccess: async () => {
      setSetup(null);
      codeForm.reset();
      await refresh();
      toast({ tone: "success", title: "Two-factor authentication enabled" });
      try {
        const fresh = await runSensitive(getRecoveryCodes);
        if (fresh) setCodes(fresh);
      } catch {
        /* recovery codes can be viewed later */
      }
    },
    onError: (err) => {
      if (isReauthCancelled(err)) return;
      setCodeError(errorMessage(err, "That code was not accepted."));
    },
  });

  const deactivate = useMutation({
    mutationFn: () => runSensitive(deactivateTotp),
    onSuccess: async () => {
      setConfirmDisable(false);
      setCodes(null);
      await refresh();
      toast({ tone: "success", title: "Two-factor authentication disabled" });
    },
    onError: fail("Could not disable two-factor authentication"),
  });

  const showCodes = useMutation({
    mutationFn: () => runSensitive(getRecoveryCodes),
    onSuccess: (data) => {
      if (data) setCodes(data);
      else toast({ title: "No recovery codes yet", description: "Generate a set to keep as a backup." });
    },
    onError: fail("Could not load recovery codes"),
  });

  const regenerate = useMutation({
    mutationFn: () => runSensitive(regenerateRecoveryCodes),
    onSuccess: async (data) => {
      setConfirmRegenerate(false);
      setCodes(data);
      await refresh();
      toast({ tone: "success", title: "Recovery codes regenerated", description: "Previous codes no longer work." });
    },
    onError: fail("Could not regenerate recovery codes"),
  });

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ tone: "success", title: `${label} copied` });
    } catch {
      toast({ tone: "error", title: "Copy failed", description: "Select the text and copy it manually." });
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-primary" aria-hidden /> Two-factor authentication
            </CardTitle>
            <CardDescription>Protect your account with a time-based code from an authenticator app.</CardDescription>
          </div>
          {authenticators.isPending ? null : totpActive ? <Badge variant="success">Enabled</Badge> : <Badge variant="warning">Not enabled</Badge>}
        </div>
      </CardHeader>
      <CardContent className="grid gap-5">
        {authenticators.isPending ? (
          <SkeletonRows rows={2} />
        ) : totpActive ? (
          <>
            <p className="text-sm text-fg-muted">An authenticator app is linked to your account. You will be asked for a code each time you sign in.</p>
            <div className="rounded-sm border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">Recovery codes</p>
                  <p className="text-xs text-fg-subtle">
                    {recoveryMeta
                      ? `${recoveryMeta.unused_code_count ?? "?"} of ${recoveryMeta.total_code_count ?? "?"} codes unused.`
                      : "Single-use backup codes for when you cannot reach your authenticator."}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => showCodes.mutate()} loading={showCodes.isPending}>
                    Show codes
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setConfirmRegenerate(true)}>
                    Regenerate
                  </Button>
                </div>
              </div>
              {codes ? <RecoveryCodeList codes={codes} onCopy={() => copy(codes.unused_codes.join("\n"), "Recovery codes")} /> : null}
            </div>
          </>
        ) : setup ? (
          <form
            onSubmit={codeForm.handleSubmit((v) => {
              setCodeError(null);
              activate.mutate(v);
            })}
            className="grid gap-4"
            noValidate
          >
            <ol className="grid gap-1 text-sm text-fg-muted">
              <li>1. Open your authenticator app and add a new account.</li>
              <li>2. Scan the QR code or enter the secret manually.</li>
              <li>3. Enter the 6-digit code the app shows to confirm.</li>
            </ol>
            <div className="flex flex-col gap-4 sm:flex-row">
              {setup.totp_url ? <TotpQr value={setup.totp_url} /> : null}
              <div className="grid flex-1 content-start gap-3">
                <div className="grid gap-1">
                  <Label>Secret</Label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 break-all rounded-sm bg-bg-subtle px-2 py-1.5 font-mono text-xs">{setup.secret}</code>
                    <Button type="button" variant="ghost" size="icon-sm" aria-label="Copy secret" onClick={() => copy(setup.secret ?? "", "Secret")}>
                      <Copy />
                    </Button>
                  </div>
                </div>
                {setup.totp_url ? (
                  <div className="grid gap-1">
                    <Label>Setup URL</Label>
                    <code className="break-all rounded-sm bg-bg-subtle px-2 py-1.5 font-mono text-[11px] text-fg-muted">{setup.totp_url}</code>
                  </div>
                ) : null}
              </div>
            </div>
            <FormError message={codeError} />
            <FormField control={codeForm.control} name="code" label="Confirmation code">
              {(field) => (
                <Input
                  {...field}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  className="max-w-48"
                  value={field.value}
                  onChange={(e) => field.onChange(e.target.value)}
                />
              )}
            </FormField>
            <div className="flex gap-2">
              <Button type="submit" loading={activate.isPending}>
                Enable two-factor
              </Button>
              <Button type="button" variant="secondary" onClick={() => setSetup(null)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-fg-muted">
              {session?.active?.mfa_required
                ? "Your organization requires two-factor authentication. Set it up to continue using Keel."
                : "Add an authenticator app such as Aegis, 1Password or Google Authenticator."}
            </p>
            <Button onClick={() => beginSetup.mutate()} loading={beginSetup.isPending}>
              Set up authenticator app
            </Button>
          </div>
        )}
        {codes && !totpActive ? <RecoveryCodeList codes={codes} onCopy={() => copy(codes.unused_codes.join("\n"), "Recovery codes")} /> : null}
      </CardContent>
      {totpActive ? (
        <CardFooter className="justify-end">
          <Button variant="danger-ghost" onClick={() => setConfirmDisable(true)}>
            <ShieldOff /> Disable two-factor
          </Button>
        </CardFooter>
      ) : null}

      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title="Disable two-factor authentication?"
        description="Your account will be protected by your password only. Organizations that require MFA will block access until it is re-enabled."
        confirmLabel="Disable"
        destructive
        loading={deactivate.isPending}
        onConfirm={() => deactivate.mutate()}
      />
      <ConfirmDialog
        open={confirmRegenerate}
        onOpenChange={setConfirmRegenerate}
        title="Regenerate recovery codes?"
        description="A new set of codes will be created and all existing codes will stop working."
        confirmLabel="Regenerate"
        loading={regenerate.isPending}
        onConfirm={() => regenerate.mutate()}
      />
    </Card>
  );
}

function RecoveryCodeList({ codes, onCopy }: { codes: RecoveryCodes; onCopy: () => void }) {
  return (
    <div className="mt-4 rounded-sm border border-warning/40 bg-warning-soft p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Store these somewhere safe. Each code works once.</p>
        <Button variant="secondary" size="sm" onClick={onCopy}>
          <Copy /> Copy
        </Button>
      </div>
      {codes.unused_codes.length ? (
        <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm sm:grid-cols-3">
          {codes.unused_codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-fg-muted">All codes have been used. Regenerate a new set.</p>
      )}
    </div>
  );
}

/* Sessions */
function SessionsCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  const sessions = useQuery({ queryKey: queryKeys.authSessions, queryFn: listSessions });

  const revoke = useMutation({
    mutationFn: (ids: Array<number | string>) => runSensitive(() => deleteSessions(ids)),
    onSuccess: async (_data, ids) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.authSessions });
      toast({ tone: "success", title: ids.length === 1 ? "Session signed out" : "Other sessions signed out" });
    },
    onError: (err) => {
      if (isReauthCancelled(err)) return;
      toast({ tone: "error", title: "Could not sign out session", description: errorMessage(err) });
    },
  });

  const others = (sessions.data ?? []).filter((s) => !s.is_current);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <MonitorSmartphone className="size-4 text-primary" aria-hidden /> Active sessions
            </CardTitle>
            <CardDescription>Devices currently signed in to your account.</CardDescription>
          </div>
          {others.length > 0 ? (
            <Button variant="secondary" size="sm" onClick={() => revoke.mutate(others.map((s) => s.id))} loading={revoke.isPending}>
              Sign out other sessions
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {sessions.isPending ? (
          <SkeletonRows rows={2} />
        ) : sessions.isError ? (
          <p className="text-sm text-danger">{errorMessage(sessions.error)}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Device</TableHead>
                <TableHead className="hidden sm:table-cell">IP address</TableHead>
                <TableHead className="hidden md:table-cell">Signed in</TableHead>
                <TableHead className="w-28">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.data.map((s) => (
                <TableRow key={String(s.id)}>
                  <TableCell>
                    <div className="max-w-xs truncate text-sm" title={s.user_agent}>
                      {s.user_agent || "Unknown device"}
                    </div>
                    {s.is_current ? <Badge variant="success" className="mt-1">This device</Badge> : null}
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs text-fg-muted sm:table-cell">{s.ip}</TableCell>
                  <TableCell className="hidden text-fg-muted md:table-cell">{formatDateTime(s.created_at)}</TableCell>
                  <TableCell className="text-right">
                    {!s.is_current ? (
                      <Button variant="danger-ghost" size="sm" onClick={() => revoke.mutate([s.id])} disabled={revoke.isPending}>
                        Sign out
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
