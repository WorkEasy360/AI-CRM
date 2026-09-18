"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, History, MoreHorizontal, Pause, Play, Plus, RotateCw, Send, Trash2, Webhook } from "lucide-react";
import { z } from "zod";
import { PageHeader } from "@/components/page-header";
import { isReauthCancelled, useReauth } from "@/components/reauth-provider";
import { DeliveriesTable } from "@/components/settings/integrations/deliveries-table";
import { deliveryErrorMessage, eventLabel } from "@/components/settings/integrations/labels";
import { CodeBlock, SecretRevealDialog, type SecretReveal } from "@/components/settings/integrations/secret-reveal-dialog";
import { WebhookStatusBadge } from "@/components/settings/integrations/status-badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import {
  createWebhook,
  deleteWebhook,
  getIntegrationOptions,
  integrationKeys,
  listWebhookDeliveries,
  listWebhooks,
  pauseWebhook,
  resumeWebhook,
  rotateWebhookSecret,
  testWebhook,
  type WebhookCreateInput,
  type WebhookSubscription,
} from "@/lib/api/integrations";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { hasPermission, useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { formatDateTime } from "@/lib/utils";

/** Used only if the options endpoint is unavailable; the server validates event types either way. */
const FALLBACK_EVENT_TYPES = ["contact.created", "contact.updated", "company.created", "company.updated", "deal.created", "deal.updated", "deal.stage_changed", "task.completed"];

const VERIFY_EXAMPLE = `Keel-Event-Id: <stable across retries; use it to ignore duplicates>
Keel-Timestamp: <unix seconds>
Keel-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>." + raw body)>`;

function VerifyNote() {
  return (
    <>
      <p>Your endpoint should verify every request before trusting it:</p>
      <CodeBlock label="Webhook signature headers">{VERIFY_EXAMPLE}</CodeBlock>
      <p className="text-xs text-fg-subtle">Compare signatures in constant time and reject timestamps older than a few minutes.</p>
    </>
  );
}

const webhookSchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(80, "Use 80 characters or fewer."),
  url: z
    .string()
    .trim()
    .min(1, "Enter the endpoint URL.")
    .regex(/^https:\/\/\S+$/i, "Use a public https:// address."),
  event_types: z.array(z.string()).min(1, "Choose at least one event."),
  include_data: z.boolean(),
});
type WebhookFormValues = z.infer<typeof webhookSchema>;
const EMPTY_WEBHOOK: WebhookFormValues = { name: "", url: "", event_types: [], include_data: false };

export function WebhooksPage() {
  const { data: session } = useSession();
  const canManage = hasPermission(session?.active ?? null, "webhooks.manage");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();

  const webhooks = useCursorList(integrationKeys.webhooks, listWebhooks, canManage);
  const options = useQuery({ queryKey: integrationKeys.options, queryFn: getIntegrationOptions, enabled: canManage, staleTime: 5 * 60_000, retry: false });
  const eventTypes = options.data?.webhook_event_types ?? FALLBACK_EVENT_TYPES;

  const [createOpen, setCreateOpen] = React.useState(false);
  // Signing secrets live only here, only until the reveal dialog closes.
  const [reveal, setReveal] = React.useState<SecretReveal | null>(null);
  const [deliveriesFor, setDeliveriesFor] = React.useState<WebhookSubscription | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<WebhookSubscription | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: integrationKeys.webhooks });
  const fail = (title: string) => (err: unknown) => {
    if (isReauthCancelled(err)) return;
    toast({ tone: "error", title, description: errorMessage(err) });
  };

  const revealSecret = (title: string, secret: string, warning: string) =>
    setReveal({ title, description: "Add this signing secret to the receiving system.", items: [{ label: "Signing secret", value: secret }], warning, children: <VerifyNote /> });

  const test = useMutation({
    mutationFn: (w: WebhookSubscription) => testWebhook(w.id),
    onSuccess: async (result) => {
      toast(
        result.ok
          ? { tone: "success", title: "Test event delivered", description: result.response_status ? `The endpoint answered HTTP ${result.response_status}.` : result.message }
          : { tone: "error", title: "Test event failed", description: result.message || deliveryErrorMessage(result.error_code) },
      );
      await refresh();
    },
    onError: fail("Could not send a test event"),
  });

  const pauseResume = useMutation({
    mutationFn: (w: WebhookSubscription) => (w.status === "active" ? pauseWebhook(w.id) : resumeWebhook(w.id)),
    onSuccess: async (updated) => {
      toast({ tone: "success", title: updated.status === "active" ? "Webhook resumed" : "Webhook paused" });
      await refresh();
    },
    onError: fail("Could not change the webhook status"),
  });

  const rotate = useMutation({
    mutationFn: async (w: WebhookSubscription) => {
      const { secret, ...subscription } = await runSensitive(() => rotateWebhookSecret(w.id));
      revealSecret(
        `New signing secret for ${subscription.name}`,
        secret,
        "Copy the secret now; it will not be shown again. For the next 24 hours Keel signs with both the new and the previous secret, so switch the receiver over within that time.",
      );
      return subscription;
    },
    onSuccess: refresh,
    onError: fail("Could not rotate the secret"),
  });

  const remove = useMutation({
    mutationFn: (w: WebhookSubscription) => runSensitive(() => deleteWebhook(w.id)),
    onSuccess: async () => {
      setDeleteTarget(null);
      toast({ tone: "success", title: "Webhook deleted" });
      await refresh();
    },
    onError: fail("Could not delete the webhook"),
  });

  const backLink = (
    <Button asChild variant="link" size="sm" className="mb-2 h-auto px-0 text-fg-muted">
      <Link href="/settings/integrations">
        <ArrowLeft /> Integrations
      </Link>
    </Button>
  );

  if (session && !canManage) {
    return (
      <div>
        {backLink}
        <PageHeader title="Webhooks" />
        <EmptyState icon={<Webhook />} title="No access" description="Your role does not include permission to manage webhooks." />
      </div>
    );
  }

  return (
    <div>
      {backLink}
      <PageHeader
        title="Webhooks"
        description="Keel sends a signed HTTPS request to your endpoint when the selected events happen."
        actions={
          canManage ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> Add webhook
            </Button>
          ) : null
        }
      />

      {!session || webhooks.isPending ? (
        <SkeletonRows rows={4} />
      ) : webhooks.isError ? (
        <EmptyState
          title="Could not load webhooks"
          description={errorMessage(webhooks.error)}
          action={
            <Button variant="secondary" onClick={() => webhooks.refetch()}>
              Retry
            </Button>
          }
        />
      ) : webhooks.items.length === 0 ? (
        <EmptyState icon={<Webhook />} title="No webhooks yet" description="Add a webhook to notify another system when records change in Keel." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Webhook</TableHead>
              <TableHead className="hidden md:table-cell">Events</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden lg:table-cell">Last success</TableHead>
              <TableHead className="hidden lg:table-cell">Last failure</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {webhooks.items.map((w) => (
              <TableRow key={w.id}>
                <TableCell className="max-w-xs">
                  <div className="truncate font-medium">{w.name}</div>
                  <div className="truncate font-mono text-xs text-fg-subtle" title={w.url}>
                    {w.url}
                  </div>
                  {w.include_data ? <div className="text-xs text-fg-subtle">Includes record fields</div> : null}
                </TableCell>
                <TableCell className="hidden max-w-xs text-fg-muted md:table-cell">
                  <span className="line-clamp-2">{w.event_types.map(eventLabel).join(", ")}</span>
                </TableCell>
                <TableCell>
                  <WebhookStatusBadge status={w.status} />
                  {w.rotation_in_progress ? <div className="mt-1 text-xs text-fg-subtle">Secret rotation in progress</div> : null}
                </TableCell>
                <TableCell className="hidden whitespace-nowrap text-fg-muted lg:table-cell">{w.last_success_at ? formatDateTime(w.last_success_at) : "Never"}</TableCell>
                <TableCell className="hidden text-fg-muted lg:table-cell">
                  {w.last_failure_at ? (
                    <>
                      <div className="whitespace-nowrap">{formatDateTime(w.last_failure_at)}</div>
                      {w.last_error_code ? <div className="max-w-56 text-xs text-danger">{deliveryErrorMessage(w.last_error_code)}</div> : null}
                    </>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${w.name}`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => test.mutate(w)} disabled={w.status !== "active"}>
                        <Send /> Send test event
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => pauseResume.mutate(w)}>
                        {w.status === "active" ? <Pause /> : <Play />} {w.status === "active" ? "Pause" : "Resume"}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => rotate.mutate(w)}>
                        <RotateCw /> Rotate secret
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setDeliveriesFor(w)}>
                        <History /> View deliveries
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem destructive onSelect={() => setDeleteTarget(w)}>
                        <Trash2 /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {webhooks.hasMore ? (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" onClick={() => webhooks.loadMore()} loading={webhooks.isLoadingMore}>
            Load more
          </Button>
        </div>
      ) : null}

      {canManage ? (
        <CreateWebhookDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          eventTypes={eventTypes}
          onCreated={(name, secret) => revealSecret(`Webhook “${name}” created`, secret, "Copy the signing secret now. For your security it will not be shown again.")}
        />
      ) : null}
      <SecretRevealDialog reveal={reveal} onClose={() => setReveal(null)} />
      <WebhookDeliveriesDialog webhook={deliveriesFor} onClose={() => setDeliveriesFor(null)} />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.name ?? "this webhook"}?`}
        description="Keel stops sending events to this endpoint immediately. This cannot be undone."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
      />
    </div>
  );
}

export function CreateWebhookDialog({
  open,
  onOpenChange,
  eventTypes,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eventTypes: string[];
  /** Receives the one-time signing secret; the caller keeps it only in reveal state. */
  onCreated: (name: string, secret: string) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const form = useForm<WebhookFormValues>({ resolver: zodResolver(webhookSchema), defaultValues: EMPTY_WEBHOOK });
  const includeId = React.useId();

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      form.reset(EMPTY_WEBHOOK);
      setFieldErrors({});
    }
    onOpenChange(next);
  };

  const create = useMutation({
    mutationFn: async (input: WebhookCreateInput) => {
      const { secret, ...subscription } = await runSensitive(() => createWebhook(input));
      // The secret goes straight to the reveal dialog; the mutation result never contains it.
      onCreated(subscription.name, secret);
      return subscription;
    },
    onSuccess: async () => {
      toast({ tone: "success", title: "Webhook created" });
      handleOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: integrationKeys.webhooks });
    },
    onError: (err) => {
      if (isReauthCancelled(err)) return;
      if (isApiError(err) && err.isValidation) {
        setFieldErrors(err.fieldErrors());
        return;
      }
      toast({ tone: "error", title: "Could not create the webhook", description: errorMessage(err) });
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    setFieldErrors({});
    create.mutate({ name: values.name.trim(), url: values.url.trim(), event_types: values.event_types, include_data: values.include_data });
  });

  const known = new Set(["name", "url", "event_types", "include_data"]);
  const general = Object.entries(fieldErrors)
    .filter(([key]) => !known.has(key))
    .map(([, message]) => message)
    .join(" ");

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Add webhook</DialogTitle>
            <DialogDescription>Keel signs every request so the receiving system can verify it came from Keel.</DialogDescription>
          </DialogHeader>
          <FormError message={general || null} />
          <FormField control={form.control} name="name" label="Name" required serverError={fieldErrors.name}>
            {(f) => <Input {...f} autoComplete="off" placeholder="Data warehouse" value={f.value} onChange={(e) => f.onChange(e.target.value)} />}
          </FormField>
          <FormField control={form.control} name="url" label="Endpoint URL" required serverError={fieldErrors.url} description="Must be a public https:// address.">
            {(f) => <Input {...f} type="url" autoComplete="off" spellCheck={false} placeholder="https://example.com/keel-webhook" value={f.value} onChange={(e) => f.onChange(e.target.value)} />}
          </FormField>
          <FormField control={form.control} name="event_types" label="Events" required serverError={fieldErrors.event_types}>
            {(f) => (
              <div role="group" aria-label="Events" aria-describedby={f["aria-describedby"]} className="grid gap-2 sm:grid-cols-2">
                {eventTypes.map((type) => {
                  const checked = f.value.includes(type);
                  return (
                    <label key={type} className="flex cursor-pointer items-start gap-2 rounded-sm border border-border px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-3.5 accent-primary"
                        checked={checked}
                        onChange={() => f.onChange(checked ? f.value.filter((v) => v !== type) : [...f.value, type])}
                      />
                      <span>
                        {eventLabel(type)}
                        <span className="block font-mono text-xs text-fg-subtle">{type}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </FormField>
          <FormField control={form.control} name="include_data" serverError={fieldErrors.include_data}>
            {(f) => (
              <div className="flex items-start gap-3 rounded-sm border border-border p-3">
                <Switch id={includeId} checked={f.value} onCheckedChange={f.onChange} aria-describedby={`${includeId}-help`} />
                <div className="grid gap-1">
                  <Label htmlFor={includeId}>Include record fields</Label>
                  <p id={`${includeId}-help`} className="text-xs text-fg-subtle">
                    Off by default: events carry only the record type and ID, and the receiver fetches details with an API key. Turn on only if the receiver needs the
                    standard fields in the event itself; share the least data it needs.
                  </p>
                </div>
              </div>
            )}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create webhook
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function WebhookDeliveriesDialog({ webhook, onClose }: { webhook: WebhookSubscription | null; onClose: () => void }) {
  const deliveries = useQuery({
    queryKey: integrationKeys.webhookDeliveries(webhook?.id ?? ""),
    queryFn: () => listWebhookDeliveries(webhook?.id ?? ""),
    enabled: webhook !== null,
  });
  return (
    <Dialog open={webhook !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Deliveries{webhook ? ` · ${webhook.name}` : ""}</DialogTitle>
          <DialogDescription>The latest 50 events sent to this endpoint. Temporary failures are retried automatically.</DialogDescription>
        </DialogHeader>
        {deliveries.isPending ? (
          <SkeletonRows rows={3} />
        ) : deliveries.isError ? (
          <p className="text-sm text-danger">{errorMessage(deliveries.error)}</p>
        ) : deliveries.data.results.length === 0 ? (
          <p className="text-sm text-fg-muted">No events have been sent yet.</p>
        ) : (
          <DeliveriesTable deliveries={deliveries.data.results} />
        )}
      </DialogContent>
    </Dialog>
  );
}
