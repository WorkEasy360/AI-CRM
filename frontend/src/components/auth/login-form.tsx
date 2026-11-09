"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { BarChart3, Eye, EyeOff, Layers, LogIn, Mail, Lock, UserPlus, Users } from "lucide-react";
import { z } from "zod";
import "@/lib/zod-config";
import { AuthHeading } from "@/components/auth/auth-heading";
import { BrandLogo } from "@/components/shell/nav";
import { Button } from "@/components/ui/button";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { login, mfaAuthenticate } from "@/lib/api/allauth";
import { setSessionPersistence } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { ssoErrorMessage, useAuthMethods, workeasy360StartUrl } from "@/lib/auth-methods";
import { safeNext } from "@/lib/safe-next";
import { queryKeys, useSession } from "@/lib/session";
import { emailSchema, totpCodeSchema } from "@/lib/validation";

const credentialsSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password."),
});
type Credentials = z.infer<typeof credentialsSchema>;

const mfaSchema = z.object({ code: totpCodeSchema });
type MfaInput = z.infer<typeof mfaSchema>;

type Stage = "credentials" | "mfa" | "verify_email";

const HIGHLIGHTS = [
  { icon: Users, label: "Manage Leads" },
  { icon: Layers, label: "Track Pipeline" },
  { icon: BarChart3, label: "Grow Sales" },
] as const;

/** The card's header: the WorkEasy360 mark with its CRM pill, then the page title. */
function LoginHeader() {
  return (
    <div className="mb-2 text-center">
      <span className="mb-4 inline-flex items-center gap-2 text-2xl font-semibold tracking-tight text-fg">
        <BrandLogo size={36} />
        <span>
          WorkEasy<span className="text-brand">360</span>
        </span>
        <span className="rounded-md bg-brand px-2 py-0.5 text-base font-bold text-brand-fg">CRM</span>
      </span>
      <h1 className="text-3xl font-bold tracking-tight text-fg">CRM Login</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm text-fg-muted">Sign in to access your WorkEasy CRM workspace and manage your sales, leads and follow-ups.</p>
    </div>
  );
}

function OrDivider() {
  return (
    <div className="flex items-center gap-3 text-xs font-medium text-fg-muted" aria-hidden>
      <span className="h-px flex-1 bg-border" />
      <span className="rounded-full border border-border px-2.5 py-1">OR</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const next = safeNext(searchParams.get("next"));
  const session = useSession();
  const methods = useAuthMethods();
  // Until the server says otherwise nothing is offered; if it cannot be asked, fall back to the
  // password form (the server still refuses it when Workeasy360 is the only sign-in).
  const passwordEnabled = methods.data ? methods.data.password : methods.isError;
  const workeasy360Enabled = methods.data?.workeasy360 ?? false;
  const [stage, setStage] = React.useState<Stage>("credentials");
  const [passwordVisible, setPasswordVisible] = React.useState(false);
  const [remember, setRemember] = React.useState(false);
  const headingId = React.useId();
  const [error, setError] = React.useState<string | null>(() => ssoErrorMessage(searchParams.get("sso_error")));
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  // Already signed in? Skip the form.
  React.useEffect(() => {
    if (stage === "credentials" && session.data?.user) router.replace(next);
  }, [session.data, stage, router, next]);

  const finish = async () => {
    // A failure only leaves the session on its normal lifetime, which must not block signing in.
    await setSessionPersistence(remember).catch(() => undefined);
    await queryClient.invalidateQueries({ queryKey: queryKeys.session });
    router.replace(next);
  };

  const credentials = useForm<Credentials>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: { email: "", password: "" },
  });

  const mfa = useForm<MfaInput>({ resolver: zodResolver(mfaSchema), defaultValues: { code: "" } });

  const onCredentials = credentials.handleSubmit(async (values) => {
    setError(null);
    setFieldErrors({});
    try {
      const outcome = await login(values);
      if (outcome.kind === "authenticated") await finish();
      else if (outcome.kind === "mfa_required") setStage("mfa");
      else if (outcome.kind === "verify_email") setStage("verify_email");
    } catch (err) {
      if (isApiError(err) && err.isValidation) setFieldErrors(err.fieldErrors());
      setError(errorMessage(err, "Sign-in failed."));
    }
  });

  const onMfa = mfa.handleSubmit(async (values) => {
    setError(null);
    try {
      const outcome = await mfaAuthenticate(values.code);
      if (outcome.kind === "authenticated") await finish();
      else setError("That code was not accepted. Try again.");
    } catch (err) {
      setError(errorMessage(err, "That code was not accepted."));
    }
  });

  if (stage === "verify_email") {
    return (
      <div>
        <AuthHeading title="Verify your email" description="Your account exists but the email address has not been verified yet." />
        <p className="text-sm text-fg-muted">
          Open the verification link we sent you. Once verified, sign in again.
        </p>
        <Button variant="secondary" className="mt-6 w-full" onClick={() => setStage("credentials")}>
          Back to sign in
        </Button>
      </div>
    );
  }

  if (stage === "mfa") {
    return (
      <form onSubmit={onMfa} className="grid gap-4" noValidate>
        <AuthHeading title="Two-factor authentication" description="Enter the 6-digit code from your authenticator app, or a recovery code." />
        <FormError message={error} />
        <FormField control={mfa.control} name="code" label="Authentication code">
          {(field) => (
            <Input
              {...field}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="123456"
              value={field.value}
              onChange={(e) => field.onChange(e.target.value)}
            />
          )}
        </FormField>
        <Button type="submit" className="w-full" loading={mfa.formState.isSubmitting}>
          Verify
        </Button>
        <Button type="button" variant="link" className="justify-self-center" onClick={() => setStage("credentials")}>
          Use a different account
        </Button>
      </form>
    );
  }

  // "Already a Workeasy360 user?": one account for every Workeasy360 product. A top-level navigation -
  // the server redirects on to Workeasy360 and back; Workeasy360 signs the person in silently, or asks
  // first, as their own sign-in preference says.
  const workeasy360Access = workeasy360Enabled ? (
    <section aria-labelledby={headingId} className="grid gap-2 rounded-lg border border-border p-4">
      <h2 id={headingId} className="text-sm font-semibold text-fg">
        Already a Workeasy360 user?
      </h2>
      <p className="text-sm text-fg-muted">Access WorkEasyCRM using your Workeasy360 account.</p>
      <Button asChild variant="secondary" className="mt-1 w-full">
        <a href={workeasy360StartUrl(next)}>Access WorkEasyCRM</a>
      </Button>
    </section>
  ) : null;

  if (!passwordEnabled) {
    return (
      <div className="grid gap-4">
        <LoginHeader />
        <FormError message={error} />
        {workeasy360Access}
        {methods.data && !workeasy360Enabled ? (
          <p className="text-sm text-fg-muted">Sign-in is not available right now. Contact your administrator.</p>
        ) : null}
      </div>
    );
  }

  return (
    <form onSubmit={onCredentials} className="grid gap-4" noValidate>
      <LoginHeader />
      <FormError message={error} />
      <FormField control={credentials.control} name="email" label="Email Address" serverError={fieldErrors.email}>
        {(field) => (
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <Input
              {...field}
              type="email"
              autoComplete="email"
              autoFocus
              placeholder="Enter your email"
              className="h-11 pl-10"
              value={field.value}
              onChange={(e) => field.onChange(e.target.value)}
            />
          </div>
        )}
      </FormField>
      <FormField control={credentials.control} name="password" label="Password" serverError={fieldErrors.password}>
        {(field) => (
          <div className="relative">
            <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
            <Input
              {...field}
              type={passwordVisible ? "text" : "password"}
              autoComplete="current-password"
              placeholder="Enter your password"
              className="h-11 pl-10 pr-11"
              value={field.value}
              onChange={(e) => field.onChange(e.target.value)}
            />
            <button
              type="button"
              onClick={() => setPasswordVisible((visible) => !visible)}
              aria-pressed={passwordVisible}
              aria-label={passwordVisible ? "Hide password" : "Show password"}
              className="absolute right-0 top-0 flex size-11 items-center justify-center rounded-md text-fg-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
            >
              {passwordVisible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
            </button>
          </div>
        )}
      </FormField>
      <div className="-mt-1 flex flex-wrap items-center justify-between gap-2">
        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-fg lg:min-h-6">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="size-4 rounded-sm border-border-strong accent-[var(--kl-brand)]" />
          Remember me
        </label>
        <Link href="/forgot-password" className="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline lg:min-h-6">
          Forgot Password?
        </Link>
      </div>
      <Button type="submit" className="h-12 w-full text-md" loading={credentials.formState.isSubmitting}>
        <LogIn aria-hidden /> Log In to CRM
      </Button>
      <OrDivider />
      {workeasy360Access}
      <Button asChild variant="secondary" className="h-12 w-full border-brand text-md">
        <Link href="/signup">
          <UserPlus aria-hidden /> Create CRM Account
        </Link>
      </Button>
      <ul className="mt-1 grid grid-cols-3 gap-2 sm:gap-3">
        {HIGHLIGHTS.map((item) => (
          <li key={item.label} className="flex flex-col items-center gap-1.5 rounded-lg bg-brand-soft px-1 py-3 text-center text-xs font-medium text-fg sm:text-sm">
            <item.icon className="size-6 text-brand" aria-hidden />
            {item.label}
          </li>
        ))}
      </ul>
    </form>
  );
}
