"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Copy, KeyRound } from "lucide-react";
import { z } from "zod";
import { isReauthCancelled, useReauth } from "@/components/reauth-provider";
import { AUTH_TYPE_LABELS, AUTH_TYPE_ORDER, copyToClipboard } from "@/components/settings/integrations/labels";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import {
  createConnection,
  getIntegrationOptions,
  integrationKeys,
  startConnectionOAuth,
  type ConnectionConventions,
  type ConnectionCreateInput,
  type ConnectionCredentials,
  type IntegrationAuthType,
} from "@/lib/api/integrations";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { isSafeExternalUrl, navigateExternal } from "@/lib/external-navigation";

const HTTPS_RE = /^https:\/\/\S+$/i;
const HTTPS_MESSAGE = "Use a full https:// address.";

export const connectionSchema = z
  .object({
    name: z.string().trim().min(1, "Enter a name for this connection.").max(80, "Use 80 characters or fewer."),
    auth_type: z.enum(["api_key", "bearer_token", "oauth2_code", "oauth2_client_credentials", "signed_webhook"]),
    base_url: z.string().trim(),
    api_key: z.string(),
    token: z.string(),
    client_secret: z.string(),
    client_id: z.string().trim(),
    authorize_url: z.string().trim(),
    token_url: z.string().trim(),
    revoke_url: z.string().trim(),
    scopes: z.string(),
    health_path: z.string().trim(),
    api_key_header: z.string().trim(),
    id_field: z.string().trim(),
    list_key: z.string().trim(),
  })
  .superRefine((v, ctx) => {
    const url = (path: "base_url" | "authorize_url" | "token_url" | "revoke_url", value: string, required: boolean, missing: string) => {
      if (!value) {
        if (required) ctx.addIssue({ code: "custom", path: [path], message: missing });
      } else if (!HTTPS_RE.test(value)) {
        ctx.addIssue({ code: "custom", path: [path], message: HTTPS_MESSAGE });
      }
    };
    if (v.auth_type !== "signed_webhook") url("base_url", v.base_url, true, "Enter the base URL of the API.");
    if (v.auth_type === "api_key" && !v.api_key) ctx.addIssue({ code: "custom", path: ["api_key"], message: "Enter the API key." });
    if (v.auth_type === "bearer_token" && !v.token) ctx.addIssue({ code: "custom", path: ["token"], message: "Enter the token." });
    if (isOAuth(v.auth_type)) {
      if (!v.client_id) ctx.addIssue({ code: "custom", path: ["client_id"], message: "Enter the client ID." });
      if (v.auth_type === "oauth2_code") url("authorize_url", v.authorize_url, true, "Enter the authorization URL.");
      url("token_url", v.token_url, true, "Enter the token URL.");
      url("revoke_url", v.revoke_url, false, "");
    }
    if (v.health_path && !v.health_path.startsWith("/")) ctx.addIssue({ code: "custom", path: ["health_path"], message: "Start the path with /." });
  });

export type ConnectionFormValues = z.infer<typeof connectionSchema>;
type FormKey = keyof ConnectionFormValues;
type TextKey = Exclude<FormKey, "auth_type">;

const EMPTY: ConnectionFormValues = {
  name: "",
  auth_type: "api_key",
  base_url: "",
  api_key: "",
  token: "",
  client_secret: "",
  client_id: "",
  authorize_url: "",
  token_url: "",
  revoke_url: "",
  scopes: "",
  health_path: "",
  api_key_header: "",
  id_field: "",
  list_key: "",
};

const ADVANCED_KEYS: readonly FormKey[] = ["health_path", "api_key_header", "id_field", "list_key"];

function isOAuth(authType: IntegrationAuthType): boolean {
  return authType === "oauth2_code" || authType === "oauth2_client_credentials";
}

/** Build the create payload: only the settings and credentials that belong to the chosen authentication type. */
export function buildConnectionPayload(v: ConnectionFormValues): ConnectionCreateInput {
  const config: ConnectionCreateInput["config"] = {};
  if (v.auth_type !== "signed_webhook") config.base_url = v.base_url.trim();
  if (isOAuth(v.auth_type)) {
    config.oauth = {
      client_id: v.client_id.trim(),
      token_url: v.token_url.trim(),
      ...(v.auth_type === "oauth2_code" ? { authorize_url: v.authorize_url.trim() } : {}),
      ...(v.revoke_url.trim() ? { revoke_url: v.revoke_url.trim() } : {}),
      scopes: v.scopes.split(/\s+/).filter(Boolean),
    };
  }
  if (v.auth_type !== "signed_webhook") {
    const conventions: ConnectionConventions = {};
    if (v.health_path.trim()) conventions.health_path = v.health_path.trim();
    if (v.auth_type === "api_key" && v.api_key_header.trim()) conventions.api_key_header = v.api_key_header.trim();
    if (v.id_field.trim()) conventions.id_field = v.id_field.trim();
    if (v.list_key.trim()) conventions.list_key = v.list_key.trim();
    if (Object.keys(conventions).length) config.conventions = conventions;
  }
  let credentials: ConnectionCredentials = {};
  if (v.auth_type === "api_key") credentials = { api_key: v.api_key };
  else if (v.auth_type === "bearer_token") credentials = { token: v.token };
  else if (isOAuth(v.auth_type) && v.client_secret) credentials = { client_secret: v.client_secret };
  return { provider: "generic_rest", name: v.name.trim(), auth_type: v.auth_type, config, credentials };
}

const SERVER_FIELDS: Record<string, FormKey> = {
  name: "name",
  auth_type: "auth_type",
  base_url: "base_url",
  "oauth.client_id": "client_id",
  "oauth.token_url": "token_url",
  "oauth.authorize_url": "authorize_url",
  "oauth.revoke_url": "revoke_url",
  "oauth.scopes": "scopes",
  "credentials.api_key": "api_key",
  "credentials.token": "token",
  "credentials.client_secret": "client_secret",
  "conventions.health_path": "health_path",
  "conventions.api_key_header": "api_key_header",
  "conventions.id_field": "id_field",
  "conventions.list_key": "list_key",
};

/** Split API field errors into per-input messages and a general banner (for errors without an input). */
export function mapServerErrors(errors: Record<string, string>): { fields: Partial<Record<FormKey, string>>; general: string | null } {
  const fields: Partial<Record<FormKey, string>> = {};
  const general: string[] = [];
  for (const [field, message] of Object.entries(errors)) {
    const key = SERVER_FIELDS[field];
    if (key) fields[key] = message;
    else general.push(message);
  }
  return { fields, general: general.length ? general.join(" ") : null };
}

export function CreateConnectionDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  const [serverErrors, setServerErrors] = React.useState<Partial<Record<FormKey, string>>>({});
  const [generalError, setGeneralError] = React.useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [created, setCreated] = React.useState<{ id: string; name: string } | null>(null);

  const options = useQuery({ queryKey: integrationKeys.options, queryFn: getIntegrationOptions, enabled: open, staleTime: 5 * 60_000 });
  const form = useForm<ConnectionFormValues>({ resolver: zodResolver(connectionSchema), defaultValues: EMPTY });
  const authType = form.watch("auth_type");

  const detailPath = (id: string) => `/settings/integrations/${encodeURIComponent(id)}`;

  const create = useMutation({
    // Credentials travel as mutation variables: drop the mutation from the cache as soon as nothing observes it.
    gcTime: 0,
    mutationFn: (payload: ConnectionCreateInput) => runSensitive(() => createConnection(payload)),
    onSuccess: async (connection) => {
      form.reset(EMPTY);
      await queryClient.invalidateQueries({ queryKey: integrationKeys.catalog });
      if (connection.auth_type === "oauth2_code") {
        setCreated({ id: connection.id, name: connection.name });
        return;
      }
      toast({ tone: "success", title: "Connection created", description: "Credentials are stored encrypted and never shown again." });
      onOpenChange(false);
      router.push(detailPath(connection.id));
    },
    onError: (err) => {
      if (isReauthCancelled(err)) return;
      if (isApiError(err) && err.isValidation) {
        const { fields, general } = mapServerErrors(err.fieldErrors());
        setServerErrors(fields);
        setGeneralError(general);
        if (ADVANCED_KEYS.some((k) => fields[k])) setAdvancedOpen(true);
        return;
      }
      if (isApiError(err) && err.type === "connection_name_taken") {
        setServerErrors({ name: errorMessage(err) });
        return;
      }
      toast({ tone: "error", title: "Could not create the connection", description: errorMessage(err) });
    },
  });

  const oauth = useMutation({
    mutationFn: (id: string) => runSensitive(() => startConnectionOAuth(id)),
    onSuccess: ({ authorization_url }) => {
      if (!isSafeExternalUrl(authorization_url)) {
        toast({ tone: "error", title: "Could not start sign-in", description: "The authorization URL is not a valid https address. Check the OAuth settings." });
        return;
      }
      navigateExternal(authorization_url);
    },
    onError: (err) => {
      if (isReauthCancelled(err)) return;
      toast({ tone: "error", title: "Could not start sign-in", description: errorMessage(err) });
    },
  });

  const close = (next: boolean) => {
    if (next) {
      onOpenChange(true);
      return;
    }
    const finished = created;
    form.reset(EMPTY);
    create.reset();
    setServerErrors({});
    setGeneralError(null);
    setAdvancedOpen(false);
    setCreated(null);
    onOpenChange(false);
    if (finished) router.push(detailPath(finished.id));
  };

  const onSubmit = form.handleSubmit((values) => {
    setServerErrors({});
    setGeneralError(null);
    create.mutate(buildConnectionPayload(values));
  });

  const copyRedirect = async (uri: string) => {
    const ok = await copyToClipboard(uri);
    toast(ok ? { tone: "success", title: "Redirect URI copied" } : { tone: "error", title: "Copy failed", description: "Select the URI and copy it manually." });
  };

  const oauthMode = isOAuth(authType);
  const redirectUri = options.data?.oauth_redirect_uri;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        {created ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Finish connecting {created.name}</DialogTitle>
              <DialogDescription>
                The connection is saved. Sign in to the external system to authorize Keel. You can also do this later from the connection page.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="secondary" onClick={() => close(false)}>
                Later
              </Button>
              <Button onClick={() => oauth.mutate(created.id)} loading={oauth.isPending}>
                <KeyRound /> Connect with OAuth
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="grid gap-4" noValidate>
            <DialogHeader>
              <DialogTitle>Connect a REST API</DialogTitle>
              <DialogDescription>Connect any system with a JSON REST API. You choose what data it can see or change after connecting.</DialogDescription>
            </DialogHeader>
            <FormError message={generalError} />
            <TextField form={form} name="name" label="Name" required serverError={serverErrors.name} placeholder="Marketing platform" />
            <FormField control={form.control} name="auth_type" label="Authentication" serverError={serverErrors.auth_type} required>
              {(f) => (
                <Select
                  value={f.value}
                  onValueChange={(value) => {
                    f.onChange(value as IntegrationAuthType);
                    // Never carry a secret typed for one method into another.
                    form.setValue("api_key", "");
                    form.setValue("token", "");
                    form.setValue("client_secret", "");
                    setServerErrors({});
                  }}
                >
                  <SelectTrigger id={f.id} aria-label="Authentication" aria-invalid={f["aria-invalid"]} aria-describedby={f["aria-describedby"]}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUTH_TYPE_ORDER.map((key) => (
                      <SelectItem key={key} value={key}>
                        {AUTH_TYPE_LABELS[key]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>

            {authType === "signed_webhook" ? (
              <p className="text-sm text-fg-muted">
                A receive-only connection: the external system sends signed webhooks to Keel. After creating it, enable the inbound webhook to get the URL and secret.
              </p>
            ) : (
              <TextField
                form={form}
                name="base_url"
                label="Base URL"
                required
                type="url"
                placeholder="https://api.example.com/v1"
                serverError={serverErrors.base_url}
              />
            )}

            {authType === "api_key" ? <TextField form={form} name="api_key" label="API key" required secret serverError={serverErrors.api_key} /> : null}
            {authType === "bearer_token" ? <TextField form={form} name="token" label="Bearer token" required secret serverError={serverErrors.token} /> : null}

            {oauthMode ? (
              <fieldset className="grid gap-4 rounded-sm border border-border p-4">
                <legend className="px-1 text-sm font-medium">OAuth 2.0</legend>
                {authType === "oauth2_code" && redirectUri ? (
                  <div className="grid gap-1.5">
                    <p className="text-xs text-fg-subtle">Register this redirect URI with the external system:</p>
                    <div className="flex items-center gap-2">
                      <code className="min-w-0 flex-1 break-all rounded-sm bg-bg-subtle px-2 py-1.5 font-mono text-xs">{redirectUri}</code>
                      <Button variant="ghost" size="icon-sm" aria-label="Copy redirect URI" onClick={() => void copyRedirect(redirectUri)}>
                        <Copy />
                      </Button>
                    </div>
                  </div>
                ) : null}
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField form={form} name="client_id" label="Client ID" required serverError={serverErrors.client_id} />
                  <TextField
                    form={form}
                    name="client_secret"
                    label="Client secret"
                    secret
                    description="Optional for public clients."
                    serverError={serverErrors.client_secret}
                  />
                </div>
                {authType === "oauth2_code" ? (
                  <TextField form={form} name="authorize_url" label="Authorization URL" required type="url" placeholder="https://" serverError={serverErrors.authorize_url} />
                ) : null}
                <TextField form={form} name="token_url" label="Token URL" required type="url" placeholder="https://" serverError={serverErrors.token_url} />
                <TextField form={form} name="revoke_url" label="Revocation URL (optional)" type="url" placeholder="https://" serverError={serverErrors.revoke_url} />
                <TextField
                  form={form}
                  name="scopes"
                  label="Scopes"
                  placeholder="contacts.read contacts.write"
                  description="Separate scopes with spaces."
                  serverError={serverErrors.scopes}
                />
              </fieldset>
            ) : null}

            {authType !== "signed_webhook" ? (
              <details open={advancedOpen} onToggle={(e) => setAdvancedOpen(e.currentTarget.open)} className="rounded-sm border border-border">
                <summary className="cursor-pointer select-none px-4 py-2.5 text-sm font-medium">Advanced</summary>
                <div className="grid gap-4 border-t border-border p-4">
                  <p className="text-xs text-fg-subtle">Only change these if the API does not follow common conventions. Leave blank to use the defaults.</p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <TextField form={form} name="health_path" label="Health check path" placeholder="/me" serverError={serverErrors.health_path} />
                    {authType === "api_key" ? (
                      <TextField form={form} name="api_key_header" label="API key header" placeholder="X-API-Key" serverError={serverErrors.api_key_header} />
                    ) : null}
                    <TextField form={form} name="id_field" label="Record ID field" placeholder="id" serverError={serverErrors.id_field} />
                    <TextField form={form} name="list_key" label="List key" placeholder="data" serverError={serverErrors.list_key} />
                  </div>
                </div>
              </details>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={create.isPending}>
                Create connection
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TextField({
  form,
  name,
  label,
  serverError,
  required,
  secret,
  type = "text",
  placeholder,
  description,
}: {
  form: UseFormReturn<ConnectionFormValues>;
  name: TextKey;
  label: string;
  serverError?: string;
  required?: boolean;
  /** Password-style input that browsers must not remember. */
  secret?: boolean;
  type?: "text" | "url";
  placeholder?: string;
  description?: string;
}) {
  return (
    <FormField control={form.control} name={name} label={label} serverError={serverError} required={required} description={description}>
      {(f) => (
        <Input
          {...f}
          type={secret ? "password" : type}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={f.value}
          onChange={(e) => f.onChange(e.target.value)}
        />
      )}
    </FormField>
  );
}
