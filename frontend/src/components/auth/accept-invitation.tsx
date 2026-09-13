"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2 } from "lucide-react";
import { AuthHeading } from "@/components/auth/auth-heading";
import { Badge, roleBadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-field";
import { Skeleton } from "@/components/ui/skeleton";
import { acceptInvitation, previewInvitation } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { useSession } from "@/lib/session";
import { formatDate } from "@/lib/utils";

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
  });

  const accept = useMutation({
    mutationFn: () => acceptInvitation(token),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      router.replace("/pipeline");
    },
  });

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
        <AuthHeading title="Invitation unavailable" description={errorMessage(preview.error, "This invitation is invalid or has expired.")} />
        <Button asChild variant="secondary" className="w-full">
          <Link href="/login">Go to sign in</Link>
        </Button>
      </div>
    );
  }

  const invitation = preview.data;
  const orgName = invitation.organization?.name;
  const authenticated = Boolean(session.data?.user);
  const sessionUnknown = session.isPending;
  const selfPath = `/invitations/accept?token=${encodeURIComponent(token)}`;
  const emailMismatch = authenticated && session.data?.user.email.toLowerCase() !== invitation.email.toLowerCase();

  return (
    <div>
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-primary-soft text-primary">
        <Building2 className="size-6" aria-hidden />
      </div>
      <AuthHeading
        title={orgName ? `Join ${orgName}` : "You have been invited"}
        description={
          <>
            {invitation.invited_by?.display_name || invitation.invited_by?.email} invited <strong>{invitation.email}</strong> to join
            {orgName ? ` ${orgName}` : " their organization"} as <Badge variant={roleBadgeVariant(invitation.role.key)}>{invitation.role.name}</Badge>.
          </>
        }
      />
      <p className="mb-4 text-xs text-fg-subtle">Expires {formatDate(invitation.expires_at)}.</p>

      {invitation.status && invitation.status !== "pending" ? (
        <FormError message={`This invitation is ${invitation.status}.`} />
      ) : sessionUnknown ? (
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
        <div className="grid gap-3">
          <p className="text-sm text-fg-muted">Sign in or create an account with {invitation.email} to accept.</p>
          {session.isError && !(isApiError(session.error) && session.error.isNotAuthenticated) ? (
            <FormError message={errorMessage(session.error)} />
          ) : null}
          <Button asChild className="w-full">
            <Link href={`/login?next=${encodeURIComponent(selfPath)}`}>Sign in</Link>
          </Button>
          <Button asChild variant="secondary" className="w-full">
            <Link href={`/signup?next=${encodeURIComponent(selfPath)}`}>Create an account</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
