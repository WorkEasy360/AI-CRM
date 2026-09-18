"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Braces, KeyRound, Mail, MessageCircle, Plug, Plus, Webhook } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { CreateConnectionDialog } from "@/components/settings/integrations/create-connection-dialog";
import { CatalogStatusBadge, ConnectionStatusBadge } from "@/components/settings/integrations/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { getIntegrationCatalog, integrationKeys, type CatalogItem, type ConnectionSummary } from "@/lib/api/integrations";
import { errorMessage } from "@/lib/api/problem";
import { hasPermission, useSession } from "@/lib/session";
import { formatDateTime } from "@/lib/utils";

export const INTEGRATIONS_PATH = "/settings/integrations";

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  oauth_state_invalid: "The sign-in link was invalid or expired. Start the connection again.",
  oauth_failed: "The provider did not complete the sign-in. Check the OAuth settings and try again.",
};

function providerIcon(key: string) {
  switch (key) {
    case "google":
    case "microsoft":
      return <Mail aria-hidden />;
    case "whatsapp":
      return <MessageCircle aria-hidden />;
    default:
      return <Braces aria-hidden />;
  }
}

export function IntegrationsPage() {
  const { data: session } = useSession();
  const canView = hasPermission(session?.active ?? null, "integrations.view");
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();

  // The OAuth callback redirects here when sign-in failed or was declined; report it once and clean the URL.
  const oauth = searchParams?.get("oauth") ?? null;
  const oauthCode = searchParams?.get("code") ?? "";
  React.useEffect(() => {
    if (oauth !== "error" && oauth !== "denied") return;
    if (oauth === "denied") {
      toast({ tone: "error", title: "Connection not authorized", description: "Sign-in was cancelled or access was declined at the provider. Nothing was changed." });
    } else {
      toast({
        tone: "error",
        title: "Could not finish connecting",
        description: OAUTH_ERROR_MESSAGES[oauthCode] ?? "The provider did not complete the connection. Try again, or check the OAuth settings.",
      });
    }
    router.replace(INTEGRATIONS_PATH, { scroll: false });
  }, [oauth, oauthCode, toast, router]);

  const catalog = useQuery({ queryKey: integrationKeys.catalog, queryFn: getIntegrationCatalog, enabled: canView });
  const [createOpen, setCreateOpen] = React.useState(false);

  if (session && !canView) {
    return (
      <div>
        <PageHeader title="Integrations" />
        <EmptyState icon={<Plug />} title="No access" description="Your role does not include permission to view integrations." />
      </div>
    );
  }

  const header = <PageHeader title="Integrations" description="Connect other systems to Keel and decide exactly which data they can see or change." />;

  if (!session || catalog.isPending) {
    return (
      <div>
        {header}
        <SkeletonRows rows={4} />
      </div>
    );
  }

  if (catalog.isError) {
    return (
      <div>
        {header}
        <EmptyState
          title="Could not load integrations"
          description={errorMessage(catalog.error)}
          action={
            <Button variant="secondary" onClick={() => catalog.refetch()}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  const { results, can_manage: canManage, can_manage_webhooks: canManageWebhooks } = catalog.data;
  const managedElsewhere = results.filter((item) => item.manage_url);
  const generic = results.find((item) => item.key === "generic_rest");
  const connections = generic?.connections ?? [];
  const connectedProviders = managedElsewhere.filter((item) => item.status !== "available");
  const availableProviders = managedElsewhere.filter((item) => item.status === "available");

  return (
    <div>
      {header}
      <section aria-labelledby="integrations-connected" className="mb-8">
        <h2 id="integrations-connected" className="mb-3 text-md font-semibold">
          Connected
        </h2>
        {connectedProviders.length === 0 && connections.length === 0 ? (
          <EmptyState icon={<Plug />} title="Nothing connected yet" description="Connect an integration below to start sharing data." className="py-8" />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {connectedProviders.map((item) => (
              <ProviderCard key={item.key} item={item} canManage={canManage} />
            ))}
            {connections.map((connection) => (
              <ConnectionCard key={connection.id} connection={connection} canManage={canManage} />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="integrations-available">
        <h2 id="integrations-available" className="mb-3 text-md font-semibold">
          Available
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {availableProviders.map((item) => (
            <ProviderCard key={item.key} item={item} canManage={canManage} />
          ))}
          {generic ? (
            <HubCard
              icon={<Braces aria-hidden />}
              title={generic.name}
              description={generic.description}
              action={
                canManage ? (
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus /> Connect
                  </Button>
                ) : null
              }
            />
          ) : null}
          <HubCard
            icon={<Webhook aria-hidden />}
            title="Webhooks"
            description="Notify other systems the moment contacts, companies or deals change in Keel."
            action={
              canManageWebhooks ? (
                <Button asChild size="sm" variant="secondary">
                  <Link href={`${INTEGRATIONS_PATH}/webhooks`}>Configure</Link>
                </Button>
              ) : null
            }
          />
          <HubCard
            icon={<KeyRound aria-hidden />}
            title="API keys"
            description="Let external software read or update CRM records through the Keel API with limited scopes."
            action={
              canManage ? (
                <Button asChild size="sm" variant="secondary">
                  <Link href={`${INTEGRATIONS_PATH}/api-keys`}>Manage keys</Link>
                </Button>
              ) : null
            }
          />
        </div>
      </section>

      {canManage ? <CreateConnectionDialog open={createOpen} onOpenChange={setCreateOpen} /> : null}
    </div>
  );
}

function HubCard({
  icon,
  title,
  description,
  badge,
  meta,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  badge?: React.ReactNode;
  meta?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader className="border-b-0 pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex min-w-0 items-center gap-2">
            <span className="text-primary [&_svg]:size-4">{icon}</span>
            <span className="truncate">{title}</span>
          </CardTitle>
          {badge}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2 pt-0">
        {description ? <p className="text-sm text-fg-muted">{description}</p> : null}
        {meta}
      </CardContent>
      {action ? <CardFooter className="justify-end">{action}</CardFooter> : null}
    </Card>
  );
}

function ProviderCard({ item, canManage }: { item: CatalogItem; canManage: boolean }) {
  const details: string[] = [];
  if (item.category === "email") {
    if (item.connected_count > 0) details.push(`${item.connected_count} ${item.connected_count === 1 ? "mailbox" : "mailboxes"} connected`);
    if (item.error_count) details.push(`${item.error_count} need${item.error_count === 1 ? "s" : ""} attention`);
    if (item.mine) details.push(`Your mailbox: ${item.mine.email_address}`);
  }
  return (
    <HubCard
      icon={providerIcon(item.key)}
      title={item.name}
      description={item.description}
      badge={<CatalogStatusBadge status={item.status} />}
      meta={
        <>
          {details.length ? <p className="text-xs text-fg-subtle">{details.join(" · ")}</p> : null}
          {item.configured === false ? <p className="text-xs text-fg-subtle">Not configured for this workspace yet.</p> : null}
        </>
      }
      action={
        canManage && item.manage_url ? (
          <Button asChild size="sm" variant="secondary">
            <Link href={item.manage_url} aria-label={`Manage ${item.name}`}>
              Manage
            </Link>
          </Button>
        ) : null
      }
    />
  );
}

function ConnectionCard({ connection, canManage }: { connection: ConnectionSummary; canManage: boolean }) {
  const needsMessage = connection.status !== "connected" && connection.status_message;
  return (
    <HubCard
      icon={<Braces aria-hidden />}
      title={connection.name}
      badge={<ConnectionStatusBadge status={connection.status} />}
      description={connection.provider_name}
      meta={
        <>
          {needsMessage ? (
            <p className={connection.status === "error" || connection.status === "action_required" ? "text-sm text-warning" : "text-sm text-fg-muted"}>{connection.status_message}</p>
          ) : null}
          <p className="text-xs text-fg-subtle">Last sync: {connection.last_sync_at ? formatDateTime(connection.last_sync_at) : "Never"}</p>
        </>
      }
      action={
        <Button asChild size="sm" variant="secondary">
          <Link href={`${INTEGRATIONS_PATH}/${encodeURIComponent(connection.id)}`} aria-label={`${canManage ? "Manage" : "View"} ${connection.name}`}>
            {canManage ? "Manage" : "View"}
          </Link>
        </Button>
      }
    />
  );
}
