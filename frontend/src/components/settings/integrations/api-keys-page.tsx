"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, KeyRound, Plus } from "lucide-react";
import { z } from "zod";
import { PageHeader } from "@/components/page-header";
import { isReauthCancelled, useReauth } from "@/components/reauth-provider";
import { CodeBlock, SecretRevealDialog, type SecretReveal } from "@/components/settings/integrations/secret-reveal-dialog";
import { ApiKeyStatusBadge } from "@/components/settings/integrations/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import {
  createApiCredential,
  getIntegrationOptions,
  integrationKeys,
  listApiCredentials,
  revokeApiCredential,
  type ApiCredential,
  type ApiCredentialCreateInput,
  type KeyLabel,
} from "@/lib/api/integrations";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { hasPermission, useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { formatDate, humanize } from "@/lib/utils";

const EXPIRY_CHOICES = [30, 90, 180, 365] as const;
const NEVER = "never";

export const API_KEY_USAGE = `Authorization: Bearer <key>

Endpoints (within the key's permissions):
/api/v1/contacts/
/api/v1/companies/
/api/v1/deals/
/api/v1/activities/`;

/** Group scopes by resource ("contacts:read" → "Contacts"), keeping the server's order. */
export function groupScopes(scopes: KeyLabel[]): { resource: string; label: string; scopes: KeyLabel[] }[] {
  const groups: { resource: string; label: string; scopes: KeyLabel[] }[] = [];
  for (const scope of scopes) {
    const resource = scope.key.split(":")[0] ?? scope.key;
    let group = groups.find((g) => g.resource === resource);
    if (!group) {
      group = { resource, label: humanize(resource), scopes: [] };
      groups.push(group);
    }
    group.scopes.push(scope);
  }
  return groups;
}

const keySchema = z.object({
  name: z.string().trim().min(1, "Enter a name.").max(80, "Use 80 characters or fewer."),
  scopes: z.array(z.string()).min(1, "Choose at least one permission."),
  expiry: z.string().min(1),
});
type KeyFormValues = z.infer<typeof keySchema>;
const EMPTY_KEY: KeyFormValues = { name: "", scopes: [], expiry: "90" };

export function ApiKeysPage() {
  const { data: session } = useSession();
  const canManage = hasPermission(session?.active ?? null, "integrations.manage");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();

  const keys = useCursorList(integrationKeys.apiCredentials, listApiCredentials, canManage);
  const options = useQuery({ queryKey: integrationKeys.options, queryFn: getIntegrationOptions, enabled: canManage, staleTime: 5 * 60_000 });
  const scopeLabel = (key: string) => options.data?.api_scopes.find((s) => s.key === key)?.label ?? humanize(key);

  const [createOpen, setCreateOpen] = React.useState(false);
  // The full key exists on the client only while this reveal dialog is open.
  const [reveal, setReveal] = React.useState<SecretReveal | null>(null);
  const [revokeTarget, setRevokeTarget] = React.useState<ApiCredential | null>(null);

  const revoke = useMutation({
    mutationFn: (credential: ApiCredential) => runSensitive(() => revokeApiCredential(credential.id)),
    onSuccess: async () => {
      setRevokeTarget(null);
      toast({ tone: "success", title: "API key revoked", description: "Requests using this key are rejected from now on." });
      await queryClient.invalidateQueries({ queryKey: integrationKeys.apiCredentials });
    },
    onError: (err) => {
      if (isReauthCancelled(err)) return;
      toast({ tone: "error", title: "Could not revoke the key", description: errorMessage(err) });
    },
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
        <PageHeader title="API keys" />
        <EmptyState icon={<KeyRound />} title="No access" description="Your role does not include permission to manage API keys." />
      </div>
    );
  }

  return (
    <div>
      {backLink}
      <PageHeader
        title="API keys"
        description="Keys let external software use the Keel API with only the permissions you grant. A key can never do more than the member who created it."
        actions={
          canManage ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> Create API key
            </Button>
          ) : null
        }
      />

      {!session || keys.isPending ? (
        <SkeletonRows rows={4} />
      ) : keys.isError ? (
        <EmptyState
          title="Could not load API keys"
          description={errorMessage(keys.error)}
          action={
            <Button variant="secondary" onClick={() => keys.refetch()}>
              Retry
            </Button>
          }
        />
      ) : keys.items.length === 0 ? (
        <EmptyState icon={<KeyRound />} title="No API keys yet" description="Create a key for each external system so you can revoke one without affecting the others." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="hidden md:table-cell">Permissions</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden lg:table-cell">Created by</TableHead>
              <TableHead className="hidden lg:table-cell">Created</TableHead>
              <TableHead className="hidden sm:table-cell">Expires</TableHead>
              <TableHead className="hidden sm:table-cell">Last used</TableHead>
              <TableHead className="w-24">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.items.map((k) => (
              <TableRow key={k.id}>
                <TableCell>
                  <div className="font-medium">{k.name}</div>
                  <div className="font-mono text-xs text-fg-subtle">{k.display_key}</div>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <div className="flex max-w-sm flex-wrap gap-1">
                    {k.scopes.map((scope) => (
                      <Badge key={scope} variant="outline">
                        {scopeLabel(scope)}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <ApiKeyStatusBadge status={k.status} />
                </TableCell>
                <TableCell className="hidden text-fg-muted lg:table-cell">{k.created_by?.display_name ?? "—"}</TableCell>
                <TableCell className="hidden whitespace-nowrap text-fg-muted lg:table-cell">{formatDate(k.created_at)}</TableCell>
                <TableCell className="hidden whitespace-nowrap text-fg-muted sm:table-cell">{k.expires_at ? formatDate(k.expires_at) : "Never"}</TableCell>
                <TableCell className="hidden whitespace-nowrap text-fg-muted sm:table-cell">{k.last_used_at ? formatDate(k.last_used_at) : "Never used"}</TableCell>
                <TableCell className="text-right">
                  {k.status === "active" ? (
                    <Button variant="danger-ghost" size="sm" onClick={() => setRevokeTarget(k)} aria-label={`Revoke ${k.name}`}>
                      Revoke
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {keys.hasMore ? (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" onClick={() => keys.loadMore()} loading={keys.isLoadingMore}>
            Load more
          </Button>
        </div>
      ) : null}

      {canManage ? (
        <CreateApiKeyDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          scopes={options.data?.api_scopes ?? []}
          scopesLoading={options.isPending}
          scopesError={options.isError ? errorMessage(options.error) : null}
          maxDays={options.data?.api_key_max_days ?? 365}
          onCreated={(name, key) =>
            setReveal({
              title: `API key “${name}” created`,
              description: "Give this key to the external system. Store it in a secret manager, never in source code.",
              items: [{ label: "API key", value: key }],
              warning: "Copy the key now. For your security it will not be shown again; if it is lost, revoke it and create a new one.",
              children: (
                <>
                  <p>Send the key in the Authorization header. It works only on these endpoints:</p>
                  <CodeBlock label="API key usage">{API_KEY_USAGE}</CodeBlock>
                </>
              ),
            })
          }
        />
      ) : null}
      <SecretRevealDialog reveal={reveal} onClose={() => setReveal(null)} />
      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title={`Revoke ${revokeTarget?.name ?? "this key"}?`}
        description="Any system using this key loses access immediately. This cannot be undone."
        confirmLabel="Revoke key"
        destructive
        loading={revoke.isPending}
        onConfirm={() => revokeTarget && revoke.mutate(revokeTarget)}
      />
    </div>
  );
}

export function CreateApiKeyDialog({
  open,
  onOpenChange,
  scopes,
  scopesLoading = false,
  scopesError = null,
  maxDays,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scopes: KeyLabel[];
  scopesLoading?: boolean;
  scopesError?: string | null;
  maxDays: number;
  /** Receives the one-time full key; the caller keeps it only in reveal state. */
  onCreated: (name: string, key: string) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const form = useForm<KeyFormValues>({ resolver: zodResolver(keySchema), defaultValues: EMPTY_KEY });
  const expiry = form.watch("expiry");
  const groups = groupScopes(scopes);
  const expiryChoices = EXPIRY_CHOICES.filter((days) => days <= maxDays);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      form.reset(EMPTY_KEY);
      setFieldErrors({});
    }
    onOpenChange(next);
  };

  const create = useMutation({
    mutationFn: async (input: ApiCredentialCreateInput) => {
      const { key, ...credential } = await runSensitive(() => createApiCredential(input));
      // The key goes straight to the reveal dialog; the mutation result never contains it.
      onCreated(credential.name, key);
      return credential;
    },
    onSuccess: async () => {
      toast({ tone: "success", title: "API key created" });
      handleOpenChange(false);
      await queryClient.invalidateQueries({ queryKey: integrationKeys.apiCredentials });
    },
    onError: (err) => {
      if (isReauthCancelled(err)) return;
      if (isApiError(err) && err.isValidation) {
        setFieldErrors(err.fieldErrors());
        return;
      }
      toast({ tone: "error", title: "Could not create the API key", description: errorMessage(err) });
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    setFieldErrors({});
    create.mutate({ name: values.name.trim(), scopes: values.scopes, expires_in_days: values.expiry === NEVER ? null : Number(values.expiry) });
  });

  const known = new Set(["name", "scopes", "expires_in_days"]);
  const general = Object.entries(fieldErrors)
    .filter(([k]) => !known.has(k))
    .map(([, message]) => message)
    .join(" ");

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>Grant only the permissions the external system needs.</DialogDescription>
          </DialogHeader>
          <FormError message={general || null} />
          <FormField control={form.control} name="name" label="Name" required serverError={fieldErrors.name} description="Name it after the system that will use it.">
            {(f) => <Input {...f} autoComplete="off" placeholder="Accounting sync" value={f.value} onChange={(e) => f.onChange(e.target.value)} />}
          </FormField>
          <FormField control={form.control} name="scopes" label="Permissions" required serverError={fieldErrors.scopes}>
            {(f) =>
              scopesLoading ? (
                <SkeletonRows rows={2} />
              ) : scopesError ? (
                <p className="text-sm text-danger">{scopesError}</p>
              ) : (
                <div role="group" aria-label="Permissions" aria-describedby={f["aria-describedby"]} className="grid gap-3 sm:grid-cols-2">
                  {groups.map((group) => (
                    <fieldset key={group.resource} className="grid gap-1.5 rounded-sm border border-border p-3">
                      <legend className="px-1 text-sm font-medium">{group.label}</legend>
                      {group.scopes.map((scope) => {
                        const checked = f.value.includes(scope.key);
                        return (
                          <label key={scope.key} className="flex cursor-pointer items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="size-3.5 accent-primary"
                              checked={checked}
                              onChange={() => f.onChange(checked ? f.value.filter((v) => v !== scope.key) : [...f.value, scope.key])}
                            />
                            {scope.label}
                          </label>
                        );
                      })}
                    </fieldset>
                  ))}
                </div>
              )
            }
          </FormField>
          <FormField control={form.control} name="expiry" label="Expires" serverError={fieldErrors.expires_in_days}>
            {(f) => (
              <Select value={f.value} onValueChange={f.onChange}>
                <SelectTrigger id={f.id} aria-label="Expires" aria-describedby={f["aria-describedby"]} className="sm:w-60">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {expiryChoices.map((days) => (
                    <SelectItem key={days} value={String(days)}>
                      After {days} days
                    </SelectItem>
                  ))}
                  <SelectItem value={NEVER}>Never expires</SelectItem>
                </SelectContent>
              </Select>
            )}
          </FormField>
          {expiry === NEVER ? (
            <p role="alert" className="rounded-sm border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
              A key that never expires stays valid until someone revokes it. Prefer an expiry date and rotate keys regularly.
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
