"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Plug } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmailTemplatesSection } from "@/components/settings/email-templates-section";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { connectEmailAccount, disconnectEmailAccount, listEmailAccounts, listEmailProviders } from "@/lib/api/crm";
import type { ConnectionStatus, EmailAccount, EmailProvider, EmailProviderOption } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { isSafeExternalUrl, navigateExternal } from "@/lib/external-navigation";
import { hasPermission, useSession } from "@/lib/session";
import { formatDateTime, humanize } from "@/lib/utils";

export const NOT_CONFIGURED_MESSAGE = "Not configured for this workspace — ask an administrator to set the OAuth credentials.";

function statusBadge(status: ConnectionStatus): { label: string; variant: BadgeProps["variant"] } {
  switch (status) {
    case "connected":
      return { label: "Connected", variant: "success" };
    case "error":
      return { label: "Needs attention", variant: "danger" };
    case "disconnected":
      return { label: "Disconnected", variant: "neutral" };
    default:
      return { label: status, variant: "neutral" };
  }
}

export function EmailSettingsPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canView = hasPermission(active, "email.view");
  const canConnect = hasPermission(active, "email.connect");
  const canManageTemplates = hasPermission(active, "email.templates_manage");
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // The OAuth provider redirects back here with ?connected=1|0; report it once and clean the URL.
  const connected = searchParams?.get("connected") ?? null;
  React.useEffect(() => {
    if (connected === null) return;
    if (connected === "1") toast({ tone: "success", title: "Mailbox connected", description: "You can now send email from the CRM." });
    else
      toast({
        tone: "error",
        title: "Mailbox not connected",
        description: "The provider did not complete the connection. Try again, or ask an administrator to check the OAuth settings.",
      });
    void queryClient.invalidateQueries({ queryKey: crmKeys.emailAccounts });
    router.replace("/settings/email", { scroll: false });
  }, [connected, toast, queryClient, router]);

  if (!canView && !canConnect) {
    return (
      <div>
        <PageHeader title="Email" />
        <EmptyState icon={<Mail />} title="No access" description="Your role does not include permission to use email." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Email" description="Send email from your own mailbox and keep every message on the record it belongs to." />
      <div className="grid gap-6">
        <MailboxCard canConnect={canConnect} />
        {canView ? <EmailTemplatesSection canManage={canManageTemplates} /> : null}
      </div>
    </div>
  );
}

function MailboxCard({ canConnect }: { canConnect: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const providers = useQuery({ queryKey: crmKeys.emailProviders, queryFn: listEmailProviders, staleTime: 5 * 60_000 });
  const accounts = useQuery({ queryKey: crmKeys.emailAccounts, queryFn: listEmailAccounts });
  const [disconnecting, setDisconnecting] = React.useState<EmailAccount | null>(null);

  const connect = useMutation({
    mutationFn: (provider: EmailProvider) => connectEmailAccount(provider),
    onSuccess: ({ authorization_url }) => {
      if (!isSafeExternalUrl(authorization_url)) {
        toast({ tone: "error", title: "Could not start sign-in", description: "The provider returned an invalid sign-in link. Ask an administrator to check the OAuth settings." });
        return;
      }
      navigateExternal(authorization_url);
    },
    onError: (err) => toast({ tone: "error", title: "Could not start sign-in", description: errorMessage(err) }),
  });

  const disconnect = useMutation({
    mutationFn: (id: string) => disconnectEmailAccount(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: crmKeys.emailAccounts });
      toast({ tone: "success", title: "Mailbox disconnected" });
      setDisconnecting(null);
    },
    onError: (err) => toast({ tone: "error", title: "Could not disconnect", description: errorMessage(err) }),
  });

  const providerLabel = (key: string) => providers.data?.results.find((p) => p.key === key)?.label ?? humanize(key);
  const rows = accounts.data?.results ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="size-4 text-primary" aria-hidden /> Connected mailbox
        </CardTitle>
        <CardDescription>
          Email is sent through your own account with OAuth; the CRM never sees your password. Replies to messages sent from here are logged automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {accounts.isPending ? (
          <SkeletonRows rows={2} />
        ) : accounts.isError ? (
          <p className="text-sm text-danger">{errorMessage(accounts.error)}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-fg-muted">No mailbox connected yet. Connect one below to send email from the CRM.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((account) => {
              const { label, variant } = statusBadge(account.status);
              return (
                <li key={account.id} className="flex flex-wrap items-start justify-between gap-3 rounded-sm border border-border p-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{account.email_address}</span>
                      <Badge variant="outline">{providerLabel(account.provider)}</Badge>
                      <Badge variant={variant}>{label}</Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-fg-subtle">
                      {account.display_name ? `${account.display_name} · ` : ""}
                      Connected {formatDateTime(account.connected_at)} · Last sync {account.last_sync_at ? formatDateTime(account.last_sync_at) : "not yet"}
                    </p>
                    {account.status === "error" && account.error_message ? (
                      <p role="alert" className="mt-1 text-xs text-danger">
                        {account.error_message}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {account.status !== "connected" && canConnect ? (
                      <Button variant="secondary" size="sm" onClick={() => connect.mutate(account.provider)} loading={connect.isPending && connect.variables === account.provider}>
                        Reconnect
                      </Button>
                    ) : null}
                    {canConnect ? (
                      <Button variant="danger-ghost" size="sm" onClick={() => setDisconnecting(account)}>
                        Disconnect
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="grid gap-2">
          <p className="text-sm font-medium">Connect a mailbox</p>
          {providers.isPending ? (
            <SkeletonRows rows={1} />
          ) : providers.isError ? (
            <p className="text-sm text-danger">{errorMessage(providers.error)}</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {providers.data.results.map((provider) => (
                <ProviderButton key={provider.key} provider={provider} canConnect={canConnect} pending={connect.isPending && connect.variables === provider.key} onConnect={() => connect.mutate(provider.key)} />
              ))}
            </div>
          )}
          {!canConnect ? <p className="text-xs text-fg-subtle">Your role cannot connect a mailbox.</p> : null}
        </div>
      </CardContent>

      <ConfirmDialog
        open={disconnecting !== null}
        onOpenChange={(open) => !open && setDisconnecting(null)}
        title={`Disconnect ${disconnecting?.email_address ?? "this mailbox"}?`}
        description="You will no longer be able to send email from the CRM until you connect a mailbox again. Messages already logged stay on their records."
        confirmLabel="Disconnect"
        destructive
        loading={disconnect.isPending}
        onConfirm={() => disconnecting && disconnect.mutate(disconnecting.id)}
      />
    </Card>
  );
}

function ProviderButton({ provider, canConnect, pending, onConnect }: { provider: EmailProviderOption; canConnect: boolean; pending: boolean; onConnect: () => void }) {
  const helpId = `provider-${provider.key}-help`;
  const disabled = !provider.configured || !canConnect;
  return (
    <div className="grid gap-1">
      <Button variant="secondary" disabled={disabled} loading={pending} onClick={onConnect} aria-describedby={!provider.configured ? helpId : undefined} className="justify-start">
        <Plug /> Connect {provider.label}
      </Button>
      {!provider.configured ? (
        <p id={helpId} className="text-xs text-fg-subtle">
          {NOT_CONFIGURED_MESSAGE}
        </p>
      ) : null}
    </div>
  );
}
