"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AuthHeading } from "@/components/auth/auth-heading";
import { Button } from "@/components/ui/button";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { login, mfaAuthenticate } from "@/lib/api/allauth";
import { errorMessage, isApiError } from "@/lib/api/problem";
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

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const next = safeNext(searchParams.get("next"));
  const session = useSession();
  const [stage, setStage] = React.useState<Stage>("credentials");
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  // Already signed in? Skip the form.
  React.useEffect(() => {
    if (stage === "credentials" && session.data?.user) router.replace(next);
  }, [session.data, stage, router, next]);

  const finish = async () => {
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

  return (
    <form onSubmit={onCredentials} className="grid gap-4" noValidate>
      <AuthHeading title="Sign in" />
      <FormError message={error} />
      <FormField control={credentials.control} name="email" label="Email" serverError={fieldErrors.email}>
        {(field) => (
          <Input
            {...field}
            type="email"
            autoComplete="email"
            autoFocus
            placeholder="you@company.com"
            value={field.value}
            onChange={(e) => field.onChange(e.target.value)}
          />
        )}
      </FormField>
      <FormField control={credentials.control} name="password" label="Password" serverError={fieldErrors.password}>
        {(field) => (
          <Input
            {...field}
            type="password"
            autoComplete="current-password"
            value={field.value}
            onChange={(e) => field.onChange(e.target.value)}
          />
        )}
      </FormField>
      <div className="-mt-2 text-right">
        <Link href="/forgot-password" className="text-xs font-medium text-primary hover:underline">
          Forgot password?
        </Link>
      </div>
      <Button type="submit" className="w-full" loading={credentials.formState.isSubmitting}>
        Sign in
      </Button>
      <p className="text-center text-sm text-fg-muted">
        New here?{" "}
        <Link href="/signup" className="font-medium text-primary hover:underline">
          Create account
        </Link>
      </p>
    </form>
  );
}
