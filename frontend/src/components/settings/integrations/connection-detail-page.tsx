"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FlaskConical, KeyRound, MoreHorizontal, Pause, Play, Plug, RefreshCw, Trash2, Unplug } from "lucide-react";
import { isReauthCancelled, useReauth } from "@/components/reauth-provider";
import { ConflictsPanel } from "@/components/settings/integrations/conflicts-panel";
import { CredentialsDialog } from "@/components/settings/integrations/credentials-dialog";
import { DeliveriesTable } from "@/components/settings/integrations/deliveries-table";
import { InboundWebhookPanel } from "@/components/settings/integrations/inbound-webhook-panel";
import { AUTH_TYPE_LABELS, entityLabel, syncIntervalLabel } from "@/components/settings/integrations/labels";
import { SharingEditor } from "@/components/settings/integrations/sharing-editor";
import { ConnectionStatusBadge, SyncJobStatusBadge } from "@/components/settings/integrations/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import {
  deleteConnection,
  disconnectConnection,
  getConnection,
  getIntegrationOptions,
  integrationKeys,
  listConnectionDeliveries,
  listConnectionJobs,
  pauseConnection,
  resumeConnection,
  startConnectionOAuth,
  syncConnection,
  testConnection,
  updateConnection,
  type ConflictStrategy,
  type ConnectionDetail,
  type ConnectionUpdateInput,
  type IntegrationOptions,
  type SyncJob,
} from "@/lib/api/integrations";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { isSafeExternalUrl, navigateExternal } from "@/lib/external-navigation";
import { hasPermission, useSession } from "@/lib/session";
import { formatDateTime } from "@/lib/utils";

const HUB_PATH = "/settings/integrations";
const BUSY_POLL_MS = 5_000;

function isBusy(connection: ConnectionDetail | undefined): boolean {
  if (!connection) return false;
  const job = connection.latest_job;
  return connection.status === "syncing" || job?.status === "pending" || job?.status === "processing";
}

export function ConnectionDetailPage({ id }: { id: string }) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canView = hasPermission(active, "integrations.view");
  const canManage = hasPermission(active, "integrations.manage");
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = React.useState("overview");

  const detailPath = `${HUB_PATH}/${encodeURIComponent(id)}`;

  // The OAuth callback lands here on success; report it once and clean the URL.
  const oauth = searchParams?.get("oauth") ?? null;
  React.useEffect(() => {
    if (oauth !== "connected") return;
    toast({ tone: "success", title: "Connected", description: "Authorization completed. Choose what data to share to start syncing." });
    void queryClient.invalidateQueries({ queryKey: integrationKeys.connection(id) });
    void queryClient.invalidateQueries({ queryKey: integrationKeys.catalog });
    router.replace(detailPath, { scroll: false });
  }, [oauth, toast, queryClient, router, id, detailPath]);

  const detail = useQuery({
    queryKey: integrationKeys.connection(id),
    queryFn: () => getConnection(id),
    enabled: canView,
    // While a sync runs, keep the dashboard current without a manual refresh.
    refetchInterval: (query) => (isBusy(query.state.data) ? BUSY_POLL_MS : false),
  });
  const options = useQuery({ queryKey: integrationKeys.options, queryFn: getIntegrationOptions, enabled: canView, staleTime: 5 * 60_000 });

  const backLink = (
    <Button asChild variant="link" size="sm" className="mb-2 h-auto px-0 text-fg-muted">
      <Link href={HUB_PATH}>
        <ArrowLeft /> Integrations
      </Link>
    </Button>
  );

  if (session && !canView) {
    return (
      <div>
        {backLink}
        <EmptyState icon={<Plug />} title="No access" description="Your role does not include permission to view integrations." />
      </div>
    );
  }
  if (!session || detail.isPending) {
    return (
      <div>
        {backLink}
        <SkeletonRows rows={5} />
      </div>
    );
  }
  if (detail.isError) {
    const missing = isApiError(detail.error) && detail.error.status === 404;
    return (
      <div>
        {backLink}
        <EmptyState
          icon={<Plug />}
          title={missing ? "Connection not found" : "Could not load this connection"}
          description={missing ? "It may have been deleted." : errorMessage(detail.error)}
          action={
            missing ? null : (
              <Button variant="secondary" onClick={() => detail.refetch()}>
                Retry
              </Button>
            )
          }
        />
      </div>
    );
  }

  const connection = detail.data;
  const showMessage = connection.status !== "connected" && connection.status_message;

  return (
    <div className="flex flex-col gap-4">
      <div>
        {backLink}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-lg font-semibold tracking-tight">{connection.name}</h1>
              <ConnectionStatusBadge status={connection.status} />
            </div>
            <p className="mt-0.5 text-xs text-fg-muted">
              {connection.provider_name} · {AUTH_TYPE_LABELS[connection.auth_type] ?? connection.auth_type}
            </p>
            {showMessage ? (
              <p role="status" className={connection.status === "error" || connection.status === "action_required" ? "mt-1 text-sm text-warning" : "mt-1 text-sm text-fg-muted"}>
                {connection.status_message}
              </p>
            ) : null}
          </div>
          {canManage ? <ConnectionActions connection={connection} /> : null}
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="overflow-x-auto">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="sharing">Data sharing</TabsTrigger>
            <TabsTrigger value="inbound">Inbound webhook</TabsTrigger>
            <TabsTrigger value="conflicts">Conflicts{connection.open_conflicts ? ` (${connection.open_conflicts})` : ""}</TabsTrigger>
            <TabsTrigger value="deliveries">Deliveries</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="overview">
          <OverviewPanel connection={connection} options={options.data} canManage={canManage} onOpenTab={setTab} />
        </TabsContent>
        <TabsContent value="sharing">
          {options.isPending ? (
            <SkeletonRows rows={4} />
          ) : options.isError ? (
            <EmptyState title="Could not load sharing options" description={errorMessage(options.error)} action={<Button variant="secondary" onClick={() => options.refetch()}>Retry</Button>} />
          ) : (
            <SharingEditor connection={connection} options={options.data} canManage={canManage} />
          )}
        </TabsContent>
        <TabsContent value="inbound">
          <InboundWebhookPanel connection={connection} canManage={canManage} />
        </TabsContent>
        <TabsContent value="conflicts">
          <ConflictsPanel connection={connection} options={options.data} canManage={canManage} />
        </TabsContent>
        <TabsContent value="deliveries">
          <DeliveriesPanel connectionId={connection.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ----------------------------------------------------------------------------- actions

function ConnectionActions({ connection }: { connection: ConnectionDetail }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  const [credentialsOpen, setCredentialsOpen] = React.useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const id = connection.id;
  const key = integrationKeys.connection(id);
  const disconnected = connection.status === "disconnected";
  const paused = connection.status === "disabled";
  const webhookOnly = connection.auth_type === "signed_webhook";
  const oauthCode = connection.auth_type === "oauth2_code";

  const fail = (title: string) => (err: unknown) => {
    if (isReauthCancelled(err)) return;
    toast({ tone: "error", title, description: errorMessage(err) });
  };
  const store = async (detail: ConnectionDetail) => {
    queryClient.setQueryData(key, detail);
    await queryClient.invalidateQueries({ queryKey: integrationKeys.catalog });
  };

  const test = useMutation({
    mutationFn: () => testConnection(id),
    onSuccess: async (result) => {
      toast(result.ok ? { tone: "success", title: "Connection works", description: result.message } : { tone: "error", title: "Connection test failed", description: result.message });
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: fail("Could not test the connection"),
  });

  const sync = useMutation({
    mutationFn: () => syncConnection(id),
    onSuccess: async () => {
      toast({ tone: "success", title: "Sync started", description: "Progress appears on the Overview tab." });
      await queryClient.invalidateQueries({ queryKey: key });
    },
    onError: fail("Could not start a sync"),
  });

  const pauseResume = useMutation({
    mutationFn: () => (paused ? resumeConnection(id) : pauseConnection(id)),
    onSuccess: async (detail) => {
      await store(detail);
      toast({ tone: "success", title: detail.status === "disabled" ? "Connection paused" : "Connection resumed", description: detail.status === "disabled" ? "Nothing is synced or delivered until you resume." : detail.status_message });
    },
    onError: fail(paused ? "Could not resume" : "Could not pause"),
  });

  const oauth = useMutation({
    mutationFn: () => runSensitive(() => startConnectionOAuth(id)),
    onSuccess: ({ authorization_url }) => {
      if (!isSafeExternalUrl(authorization_url)) {
        toast({ tone: "error", title: "Could not start sign-in", description: "The authorization URL is not a valid https address. Check the OAuth settings." });
        return;
      }
      navigateExternal(authorization_url);
    },
    onError: fail("Could not start sign-in"),
  });

  const disconnect = useMutation({
    mutationFn: () => runSensitive(() => disconnectConnection(id)),
    onSuccess: async (detail) => {
      setConfirmDisconnect(false);
      await store(detail);
      toast({ tone: "success", title: "Disconnected", description: "Stored credentials were removed. CRM data is unchanged." });
    },
    onError: fail("Could not disconnect"),
  });

  const remove = useMutation({
    mutationFn: () => runSensitive(() => deleteConnection(id)),
    onSuccess: async () => {
      setConfirmDelete(false);
      toast({ tone: "success", title: "Connection deleted" });
      router.push(HUB_PATH);
      queryClient.removeQueries({ queryKey: key });
      await queryClient.invalidateQueries({ queryKey: integrationKeys.catalog });
    },
    onError: fail("Could not delete the connection"),
  });

  const showOAuth = oauthCode && connection.status !== "connected" && connection.status !== "syncing" && connection.status !== "disabled";

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {showOAuth ? (
        <Button size="sm" onClick={() => oauth.mutate()} loading={oauth.isPending}>
          <KeyRound /> Connect with OAuth
        </Button>
      ) : null}
      {!disconnected && !webhookOnly ? (
        <>
          <Button variant="secondary" size="sm" onClick={() => test.mutate()} loading={test.isPending}>
            <FlaskConical /> Test connection
          </Button>
          <Button variant="secondary" size="sm" onClick={() => sync.mutate()} loading={sync.isPending} disabled={paused || isBusy(connection)}>
            <RefreshCw /> Sync now
          </Button>
        </>
      ) : null}
      {disconnected ? (
        <Button variant={oauthCode ? "secondary" : "primary"} size="sm" onClick={() => setCredentialsOpen(true)}>
          <Plug /> Reconnect
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="More connection actions">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!disconnected ? (
            <DropdownMenuItem onSelect={() => pauseResume.mutate()} disabled={pauseResume.isPending}>
              {paused ? <Play /> : <Pause />} {paused ? "Resume" : "Pause"}
            </DropdownMenuItem>
          ) : null}
          {!webhookOnly && !disconnected ? (
            <DropdownMenuItem onSelect={() => setCredentialsOpen(true)}>
              <KeyRound /> Update credentials
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          {disconnected ? (
            <DropdownMenuItem destructive onSelect={() => setConfirmDelete(true)}>
              <Trash2 /> Delete connection
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem destructive onSelect={() => setConfirmDisconnect(true)}>
              <Unplug /> Disconnect
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <CredentialsDialog connection={connection} open={credentialsOpen} onOpenChange={setCredentialsOpen} />
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={`Disconnect ${connection.name}?`}
        description="Keel stops syncing and delivering data, revokes access where the provider supports it, and deletes the stored credentials and inbound webhook secret. CRM data, including records that were synced, is kept."
        confirmLabel="Disconnect"
        destructive
        loading={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${connection.name}?`}
        description="The connection, its sharing settings and its sync history are removed. CRM records are not deleted."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

// ----------------------------------------------------------------------------- overview

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-fg-subtle">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{children}</dd>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "danger" | "success" }) {
  return (
    <div className="rounded-sm border border-border px-3 py-2">
      <div className="text-xs text-fg-subtle">{label}</div>
      <div className={tone === "danger" && value > 0 ? "text-lg font-semibold tabular-nums text-danger" : tone === "success" ? "text-lg font-semibold tabular-nums text-success" : "text-lg font-semibold tabular-nums"}>
        {value}
      </div>
    </div>
  );
}

function OverviewPanel({
  connection,
  options,
  canManage,
  onOpenTab,
}: {
  connection: ConnectionDetail;
  options?: IntegrationOptions;
  canManage: boolean;
  onOpenTab: (tab: string) => void;
}) {
  const job = connection.latest_job;
  const webhookOnly = connection.auth_type === "signed_webhook";
  const nextSync = webhookOnly
    ? "Not applicable"
    : connection.sync_interval_minutes === 0
      ? "Manual only"
      : connection.next_sync_at
        ? formatDateTime(connection.next_sync_at)
        : "—";

  return (
    <div className="grid gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Status</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <Fact label="Status">
                <span className="flex flex-wrap items-center gap-2">
                  <ConnectionStatusBadge status={connection.status} />
                  {connection.status !== "connected" ? <span className="text-fg-muted">{connection.status_message}</span> : null}
                </span>
              </Fact>
              <Fact label="Authentication">
                {AUTH_TYPE_LABELS[connection.auth_type] ?? connection.auth_type}
                {connection.credentials_configured.length ? <span className="block text-xs text-fg-subtle">Credentials stored encrypted</span> : null}
              </Fact>
              {connection.config.base_url ? (
                <Fact label="Base URL">
                  <span className="font-mono text-xs">{connection.config.base_url}</span>
                </Fact>
              ) : null}
              <Fact label="Connected by">
                {connection.connected_by?.display_name ?? "—"}
                {connection.connected_at ? <span className="block text-xs text-fg-subtle">{formatDateTime(connection.connected_at)}</span> : null}
              </Fact>
              <Fact label="Last sync">{connection.last_sync_at ? formatDateTime(connection.last_sync_at) : "Never"}</Fact>
              <Fact label="Last successful sync">{connection.last_success_at ? formatDateTime(connection.last_success_at) : "Never"}</Fact>
              <Fact label="Next scheduled sync">{nextSync}</Fact>
              {connection.last_error_message ? (
                <Fact label="Last error">
                  <span className="text-danger">{connection.last_error_message}</span>
                  {connection.last_error_at ? <span className="block text-xs text-fg-subtle">{formatDateTime(connection.last_error_at)}</span> : null}
                </Fact>
              ) : null}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Latest sync</CardTitle>
              {job ? <SyncJobStatusBadge status={job.status} /> : null}
            </div>
            {job ? (
              <CardDescription>
                {job.trigger === "manual" ? "Started manually" : "Scheduled"} · {formatDateTime(job.started_at ?? job.created_at)}
                {job.finished_at ? ` · Finished ${formatDateTime(job.finished_at)}` : ""}
              </CardDescription>
            ) : null}
          </CardHeader>
          <CardContent className="grid gap-4">
            {job ? (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label="Processed" value={job.processed} />
                  <Stat label="Succeeded" value={job.succeeded} tone="success" />
                  <Stat label="Failed" value={job.failed} tone="danger" />
                  <Stat label="Conflicts" value={job.conflicts} />
                </div>
                {job.error_message ? <p className="text-sm text-danger">{job.error_message}</p> : null}
                {job.errors.length ? (
                  <div className="grid gap-1.5">
                    <p className="text-sm font-medium">Recent errors</p>
                    <ul className="grid gap-1.5">
                      {job.errors.slice(0, 5).map((e, index) => (
                        <li key={`${e.entity_type}-${e.record_id}-${index}`} className="text-sm">
                          <span>{e.message || "This record could not be synced."}</span>
                          {e.entity_type || e.record_id ? (
                            <span className="block text-xs text-fg-subtle">
                              {e.entity_type ? entityLabel(e.entity_type) : "Record"}
                              {e.record_id ? ` · ${e.record_id}` : ""}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    {job.errors.length > 5 ? <p className="text-xs text-fg-subtle">and {job.errors.length - 5} more</p> : null}
                  </div>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-fg-muted">{webhookOnly ? "This connection receives data through its inbound webhook and does not sync on a schedule." : "No sync has run yet."}</p>
            )}
            <div className="flex flex-wrap gap-3 border-t border-border pt-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-fg-muted">Open conflicts:</span>
                <span className="font-medium tabular-nums">{connection.open_conflicts}</span>
                {connection.open_conflicts ? (
                  <Button variant="link" size="sm" onClick={() => onOpenTab("conflicts")}>
                    Review
                  </Button>
                ) : null}
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-fg-muted">Failed deliveries:</span>
                <span className={connection.failed_deliveries ? "font-medium tabular-nums text-danger" : "font-medium tabular-nums"}>{connection.failed_deliveries}</span>
                {connection.failed_deliveries ? (
                  <Button variant="link" size="sm" onClick={() => onOpenTab("deliveries")}>
                    View
                  </Button>
                ) : null}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {options ? <SyncSettingsCard key={`${connection.sync_interval_minutes}:${connection.conflict_strategy}`} connection={connection} options={options} canManage={canManage} /> : null}
      <SyncJobsCard connection={connection} />
    </div>
  );
}

function SyncSettingsCard({ connection, options, canManage }: { connection: ConnectionDetail; options: IntegrationOptions; canManage: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [interval, setIntervalValue] = React.useState(String(connection.sync_interval_minutes));
  const [strategy, setStrategy] = React.useState<ConflictStrategy>(connection.conflict_strategy);
  const webhookOnly = connection.auth_type === "signed_webhook";
  const intervalId = React.useId();
  const strategyId = React.useId();

  const intervals = options.sync_intervals.includes(connection.sync_interval_minutes) ? options.sync_intervals : [...options.sync_intervals, connection.sync_interval_minutes];

  const changes: ConnectionUpdateInput = {};
  if (!webhookOnly && Number(interval) !== connection.sync_interval_minutes) changes.sync_interval_minutes = Number(interval);
  if (strategy !== connection.conflict_strategy) changes.conflict_strategy = strategy;
  const dirty = Object.keys(changes).length > 0;

  const save = useMutation({
    mutationFn: (input: ConnectionUpdateInput) => updateConnection(connection.id, input),
    onSuccess: async (detail) => {
      queryClient.setQueryData(integrationKeys.connection(connection.id), detail);
      toast({ tone: "success", title: "Sync settings saved" });
      await queryClient.invalidateQueries({ queryKey: integrationKeys.catalog });
    },
    onError: (err) => toast({ tone: "error", title: "Could not save sync settings", description: errorMessage(err) }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sync settings</CardTitle>
        <CardDescription>How often Keel syncs shared data, and what happens when a record changed in both systems.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        {webhookOnly ? null : (
          <div className="grid gap-1.5">
            <Label htmlFor={intervalId}>Sync frequency</Label>
            <Select value={interval} onValueChange={setIntervalValue} disabled={!canManage}>
              <SelectTrigger id={intervalId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {intervals.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {syncIntervalLabel(minutes)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor={strategyId}>When both systems changed a record</Label>
          <Select value={strategy} onValueChange={(value) => setStrategy(value as ConflictStrategy)} disabled={!canManage}>
            <SelectTrigger id={strategyId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.conflict_strategies.map((s) => (
                <SelectItem key={s.key} value={s.key}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardContent>
      {canManage ? (
        <CardFooter className="justify-end">
          <Button size="sm" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(changes)}>
            Save settings
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

function jobDuration(job: SyncJob): string {
  if (!job.started_at || !job.finished_at) return "—";
  const seconds = Math.max(0, Math.round((new Date(job.finished_at).getTime() - new Date(job.started_at).getTime()) / 1000));
  if (Number.isNaN(seconds)) return "—";
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function SyncJobsCard({ connection }: { connection: ConnectionDetail }) {
  const jobs = useQuery({
    queryKey: integrationKeys.jobs(connection.id),
    queryFn: () => listConnectionJobs(connection.id),
    refetchInterval: isBusy(connection) ? BUSY_POLL_MS : false,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent sync jobs</CardTitle>
      </CardHeader>
      <CardContent>
        {jobs.isPending ? (
          <SkeletonRows rows={3} />
        ) : jobs.isError ? (
          <p className="text-sm text-danger">{errorMessage(jobs.error)}</p>
        ) : jobs.data.results.length === 0 ? (
          <p className="text-sm text-fg-muted">No sync jobs yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Trigger</TableHead>
                <TableHead className="text-right">Processed</TableHead>
                <TableHead className="text-right">Succeeded</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead className="hidden text-right md:table-cell">Conflicts</TableHead>
                <TableHead className="hidden md:table-cell">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.data.results.map((job) => (
                <TableRow key={job.id}>
                  <TableCell className="whitespace-nowrap">{formatDateTime(job.started_at ?? job.created_at)}</TableCell>
                  <TableCell>
                    <SyncJobStatusBadge status={job.status} />
                    {job.error_message ? <p className="mt-1 max-w-xs text-xs text-danger">{job.error_message}</p> : null}
                  </TableCell>
                  <TableCell className="hidden text-fg-muted sm:table-cell">{job.trigger === "manual" ? "Manual" : "Scheduled"}</TableCell>
                  <TableCell className="text-right tabular-nums">{job.processed}</TableCell>
                  <TableCell className="text-right tabular-nums">{job.succeeded}</TableCell>
                  <TableCell className={job.failed ? "text-right tabular-nums text-danger" : "text-right tabular-nums"}>{job.failed}</TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{job.conflicts}</TableCell>
                  <TableCell className="hidden text-fg-muted md:table-cell">{jobDuration(job)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function DeliveriesPanel({ connectionId }: { connectionId: string }) {
  const deliveries = useQuery({ queryKey: integrationKeys.deliveries(connectionId), queryFn: () => listConnectionDeliveries(connectionId) });
  if (deliveries.isPending) return <SkeletonRows rows={3} />;
  if (deliveries.isError) {
    return (
      <EmptyState
        title="Could not load deliveries"
        description={errorMessage(deliveries.error)}
        action={
          <Button variant="secondary" onClick={() => deliveries.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }
  if (deliveries.data.results.length === 0) {
    return <EmptyState title="No deliveries yet" description="Changes Keel pushes to this connection appear here, with the result of each attempt." />;
  }
  return (
    <div className="grid gap-3">
      <p className="text-sm text-fg-muted">The latest 50 changes Keel pushed to this connection. Failed deliveries are retried automatically when the problem is temporary.</p>
      <DeliveriesTable deliveries={deliveries.data.results} />
    </div>
  );
}
