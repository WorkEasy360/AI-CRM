"use client";

import * as React from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { MailCheck } from "lucide-react";
import { z } from "zod";
import { AuthHeading } from "@/components/auth/auth-heading";
import { Button } from "@/components/ui/button";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { requestPasswordReset } from "@/lib/api/allauth";
import { errorMessage } from "@/lib/api/problem";
import { emailSchema } from "@/lib/validation";

const schema = z.object({ email: emailSchema });
type Input_ = z.infer<typeof schema>;

export function ForgotPasswordForm() {
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const form = useForm<Input_>({ resolver: zodResolver(schema), defaultValues: { email: "" } });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await requestPasswordReset(values.email);
      setSent(true);
    } catch (err) {
      setError(errorMessage(err, "Could not send the reset email."));
    }
  });

  if (sent) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-success-soft text-success">
          <MailCheck className="size-6" aria-hidden />
        </div>
        <AuthHeading title="Check your email" description="If an account exists for that address, a password reset link is on its way." />
        <Button asChild variant="secondary" className="w-full">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <AuthHeading title="Reset your password" description="Enter your email and we will send you a reset link." />
      <FormError message={error} />
      <FormField control={form.control} name="email" label="Email">
        {(field) => (
          <Input
            {...field}
            type="email"
            autoComplete="email"
            autoFocus
            value={field.value}
            onChange={(e) => field.onChange(e.target.value)}
          />
        )}
      </FormField>
      <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
        Send reset link
      </Button>
      <p className="text-center text-sm text-fg-muted">
        <Link href="/login" className="font-medium text-primary hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
