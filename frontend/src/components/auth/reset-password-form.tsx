"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2 } from "lucide-react";
import { z } from "zod";
import { AuthHeading } from "@/components/auth/auth-heading";
import { Button } from "@/components/ui/button";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { resetPassword } from "@/lib/api/allauth";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { passwordSchema } from "@/lib/validation";

const schema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords do not match." });
type Input_ = z.infer<typeof schema>;

export function ResetPasswordForm() {
  const params = useParams<{ key: string }>();
  const [done, setDone] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const form = useForm<Input_>({ resolver: zodResolver(schema), defaultValues: { password: "", confirm: "" } });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    setFieldErrors({});
    let key = params.key ?? "";
    try {
      key = decodeURIComponent(key);
    } catch {
      /* keep raw */
    }
    try {
      await resetPassword({ key, password: values.password });
      setDone(true);
    } catch (err) {
      if (isApiError(err) && err.isValidation) setFieldErrors(err.fieldErrors());
      setError(errorMessage(err, "This reset link is invalid or has expired."));
    }
  });

  if (done) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-success-soft text-success">
          <CheckCircle2 className="size-6" aria-hidden />
        </div>
        <AuthHeading title="Password updated" description="You can now sign in with your new password." />
        <Button asChild className="w-full">
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <AuthHeading title="Choose a new password" />
      <FormError message={error ?? fieldErrors.key} />
      <FormField control={form.control} name="password" label="New password" description="At least 10 characters." serverError={fieldErrors.password}>
        {(field) => (
          <Input {...field} type="password" autoComplete="new-password" autoFocus value={field.value} onChange={(e) => field.onChange(e.target.value)} />
        )}
      </FormField>
      <FormField control={form.control} name="confirm" label="Confirm new password">
        {(field) => (
          <Input {...field} type="password" autoComplete="new-password" value={field.value} onChange={(e) => field.onChange(e.target.value)} />
        )}
      </FormField>
      <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
        Update password
      </Button>
    </form>
  );
}
