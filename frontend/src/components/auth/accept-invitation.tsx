"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Building2 } from "lucide-react";
import { z } from "zod";
import { AuthHeading } from "@/components/auth/auth-heading";
import { Badge, roleBadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { acceptInvitation, getSession, previewInvitation, registerWithInvitation } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/problem";
import type { InvitationPreview } from "@/lib/api/types";
import { queryKeys, useSession } from "@/lib/session";
import { formatDate } from "@/lib/utils";
import { PASSWORD_HINT, nameSchema, passwordSchema } from "@/lib/validation";

const registerSchema = z
  .object({ name: nameSchema, password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords do not match." });
type RegisterInput = z.infer<typeof registerSchema>;

/**
 * Invitation landing page. The token is the only thing read from the URL; organization, role and team
 * come from the server. New people create their password here (the link proves they own the address);
 * people who already have a Keel account sign in and accept.
 */
export function AcceptInvitation() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const token = searchParams.get("token") ?? "";
  const session = useSession();

  const preview = useQuery({
    queryKey: ["invitations", "preview", token],
    queryFn: () => previewInvitation(token),
    enabled: token.length > 0,
    retry: false,
  });

  /** Land in the CRM, or on Security first when the organization requires a second factor. */
  const enterCrm = async () => {
    await queryClient.invalidateQueries();
    const fresh = await queryClient.fetchQuery({ queryKey: queryKeys.session, queryFn: ({ signal }) => getSession(signal) });
    router.replace(fresh.active?.mfa_required ? "/settings/security" : "/pipeline");
  };

  const accept = useMutation({ mutationFn: () => acceptInvitation(token), onSuccess: enterCrm });

  if (!token) {
    return (
      <div>
        <AuthHeading title="Invitation link incomplete" description="This link is missing its invitation token. Ask the sender for a new one." />
        <Button asChild variant="secondary" className="w-full">
          <Link href="/login">Go to sign in</Link>
        </Button>
      </div>
    );
  }

  if (preview.isPending) {
    return (
      <div className="grid gap-3" role="status" aria-label="Loading invitation">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (preview.isError) {
    return (
      <div>
        <AuthHeading title="Invitation unavailable" description="This invitation is invalid, was already used or has expired. Ask the sender for a new one." />
        <Button asChild variant="secondary" className="w-full">
          <Link href="/login">Go to sign in</Link>
        </Button>
      </div>
    );
  }

  const invitation = preview.data;
  const authenticated = Boolean(session.data?.user);
  const selfPath = `/invitations/accept?token=${encodeURIComponent(token)}`;
  const emailMismatch = authenticated && session.data?.user.email.toLowerCase() !== invitation.email.toLowerCase();

  return (
    <div>
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-primary-soft text-primary">
        <Building2 className="size-6" aria-hidden />
      </div>
      <AuthHeading
        title={`Join ${invitation.organization_name}`}
        description={
          <>
            {invitation.invited_by || "An administrator"} invited <strong>{invitation.email}</strong> to join as{" "}
            <Badge variant={roleBadgeVariant(invitation.role)}>{invitation.role_name}</Badge>.
          </>
        }
      />
      <p className="mb-4 text-xs text-fg-subtle">Expires {formatDate(invitation.expires_at)}.</p>

      {session.isPending ? (
        <Skeleton className="h-10 w-full" />
      ) : authenticated ? (
        <div className="grid gap-3">
          {emailMismatch ? (
            <FormError message={`You are signed in as ${session.data?.user.email}, but this invitation was sent to ${invitation.email}.`} />
          ) : null}
          {accept.isError ? <FormError message={errorMessage(accept.error)} /> : null}
          <Button className="w-full" loading={accept.isPending} onClick={() => accept.mutate()} disabled={Boolean(emailMismatch)}>
            Accept invitation
          </Button>
          {emailMismatch ? (
            <Button asChild variant="secondary" className="w-full">
              <Link href={`/login?next=${encodeURIComponent(selfPath)}`}>Sign in with a different account</Link>
            </Button>
          ) : null}
        </div>
      ) : (
        <CreateAccountForm token={token} invitation={invitation} signInHref={`/login?next=${encodeURIComponent(selfPath)}`} onDone={enterCrm} />
      )}
    </div>
  );
}

function CreateAccountForm({
  token,
  invitation,
  signInHref,
  onDone,
}: {
  token: string;
  invitation: InvitationPreview;
  signInHref: string;
  onDone: () => Promise<void>;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const [accountExists, setAccountExists] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const form = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: invitation.name ?? "", password: "", confirm: "" },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    setFieldErrors({});
    try {
      await registerWithInvitation({ token, name: values.name, password: values.password });
      await onDone();
    } catch (err) {
      if (isApiError(err) && err.type === "account_exists") {
        setAccountExists(true);
        return;
      }
      if (isApiError(err) && err.isValidation) setFieldErrors(err.fieldErrors());
      setError(errorMessage(err, "Could not create your account."));
    }
  });

  if (accountExists) {
    return (
      <div className="grid gap-3">
        <FormError message={`${invitation.email} already has a Keel account. Sign in to accept the invitation.`} />
        <Button asChild className="w-full">
          <Link href={signInHref}>Sign in to accept</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <p className="text-sm text-fg-muted">Create your password to finish setting up your account.</p>
      <FormError message={error && !Object.keys(fieldErrors).length ? error : null} />
      <FormField control={form.control} name="name" label="Name" serverError={fieldErrors.name}>
        {(field) => <Input {...field} autoComplete="name" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
      </FormField>
      <div className="grid gap-1.5">
        <span className="text-sm font-medium">Email</span>
        <p className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-fg-muted">{invitation.email}</p>
      </div>
      <FormField control={form.control} name="password" label="Password" description={PASSWORD_HINT} serverError={fieldErrors.password}>
        {(field) => (
          <Input {...field} type="password" autoComplete="new-password" autoFocus value={field.value} onChange={(e) => field.onChange(e.target.value)} />
        )}
      </FormField>
      <FormField control={form.control} name="confirm" label="Confirm password">
        {(field) => <Input {...field} type="password" autoComplete="new-password" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
      </FormField>
      <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
        Create account and join
      </Button>
      <p className="text-center text-sm text-fg-muted">
        Already have a Keel account?{" "}
        <Link href={signInHref} className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
