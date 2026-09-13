"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { MailCheck } from "lucide-react";
import { z } from "zod";
import { AuthHeading } from "@/components/auth/auth-heading";
import { Button } from "@/components/ui/button";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { signup } from "@/lib/api/allauth";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { queryKeys } from "@/lib/session";
import { emailSchema, passwordSchema } from "@/lib/validation";

const schema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords do not match." });
type SignupInput = z.infer<typeof schema>;

export function SignupForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [done, setDone] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  const form = useForm<SignupInput>({
    resolver: zodResolver(schema),
    defaultValues: { email: "", password: "", confirm: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    setFieldErrors({});
    try {
      const outcome = await signup({ email: values.email, password: values.password });
      if (outcome.kind === "authenticated") {
        await queryClient.invalidateQueries({ queryKey: queryKeys.session });
        router.replace("/onboarding/create-organization");
        return;
      }
      setDone(values.email);
    } catch (err) {
      if (isApiError(err) && err.isValidation) setFieldErrors(err.fieldErrors());
      setError(errorMessage(err, "Could not create your account."));
    }
  });

  if (done) {
    return (
      <div className="text-center" data-testid="signup-check-email">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-success-soft text-success">
          <MailCheck className="size-6" aria-hidden />
        </div>
        <AuthHeading title="Check your email" description={`We sent a verification link to ${done}.`} />
        <p className="text-sm text-fg-muted">Open the link to verify your address, then sign in to set up your organization.</p>
        <Button asChild variant="secondary" className="mt-6 w-full">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <AuthHeading title="Create your account" description="Start with your work email. You will create or join an organization next." />
      <FormError message={error} />
      <FormField control={form.control} name="email" label="Work email" serverError={fieldErrors.email}>
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
      <FormField
        control={form.control}
        name="password"
        label="Password"
        description="At least 10 characters."
        serverError={fieldErrors.password}
      >
        {(field) => (
          <Input {...field} type="password" autoComplete="new-password" value={field.value} onChange={(e) => field.onChange(e.target.value)} />
        )}
      </FormField>
      <FormField control={form.control} name="confirm" label="Confirm password">
        {(field) => (
          <Input {...field} type="password" autoComplete="new-password" value={field.value} onChange={(e) => field.onChange(e.target.value)} />
        )}
      </FormField>
      <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
        Create account
      </Button>
      <p className="text-center text-sm text-fg-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
