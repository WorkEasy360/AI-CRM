"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Copy, MessageCircle, Webhook } from "lucide-react";
import { z } from "zod";
import { PageHeader } from "@/components/page-header";
import { isReauthCancelled, useReauth } from "@/components/reauth-provider";
import { WhatsAppTemplatesSection } from "@/components/settings/whatsapp-templates-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { connectWhatsAppAccount, disconnectWhatsAppAccount, getWhatsAppAccount } from "@/lib/api/crm";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { hasPermission, useSession } from "@/lib/session";
import { formatDateTime } from "@/lib/utils";

export const WHATSAPP_WEBHOOK_PATH = "/api/v1/whatsapp/webhook/";

const connectSchema = z.object({
  phone_number_id: z.string().trim().min(1, "Enter the phone number ID from Meta.").regex(/^\d+$/, "Meta phone number IDs contain digits only."),
  business_account_id: z.string().trim().refine((v) => v === "" || /^\d+$/.test(v), "Business account IDs contain digits only."),
  access_token: z.string().trim().min(1, "Enter the permanent access token."),
});
type ConnectInput = z.infer<typeof connectSchema>;

export function WhatsAppSettingsPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canView = hasPermission(active, "whatsapp.view");
  const canManage = hasPermission(active, "whatsapp.manage");

  if (!canView && !canManage) {
    return (
      <div>
        <PageHeader title="WhatsApp" />
        <EmptyState icon={<MessageCircle />} title="No access" description="Your role does not include permission to use WhatsApp." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="WhatsApp" description="Message customers through the WhatsApp Business Cloud API and keep the conversation on their record." />
      <div className="grid gap-6">
        <ConnectionCard canManage={canManage} />
        <WebhookCard />
        <WhatsAppTemplatesSection canManage={canManage} />
      </div>
    </div>
  );
}

function ConnectionCard({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  const account = useQuery({ queryKey: crmKeys.whatsappAccount, queryFn: getWhatsAppAccount });
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  const form = useForm<ConnectInput>({ resolver: zodResolver(connectSchema), defaultValues: { phone_number_id: "", business_account_id: "", access_token: "" } });

  const refresh = () => queryClient.invalidateQueries({ queryKey: crmKeys.whatsappAccount });

  const connect = useMutation({
    mutationFn: (v: ConnectInput) =>
      runSensitive(() =>
        connectWhatsAppAccount({ phone_number_id: v.phone_number_id, access_token: v.access_token, ...(v.business_account_id ? { business_account_id: v.business_account_id } : {}) }),
      ),
    onSuccess: async () => {
      form.reset();
      await refresh();
      toast({ tone: "success", title: "WhatsApp connected", description: "The access token is stored encrypted and never shown again." });
    },
    onError: (err) => {
      form.setValue("access_token", "");
      if (isReauthCancelled(err)) return;
      if (isApiError(err) && err.isValidation) {
        setFieldErrors(err.fieldErrors());
        return;
      }
      toast({ tone: "error", title: "Could not connect WhatsApp", description: errorMessage(err) });
    },
  });

  const disconnect = useMutation({
    mutationFn: () => runSensitive(disconnectWhatsAppAccount),
    onSuccess: async () => {
      setConfirmDisconnect(false);
      await refresh();
      toast({ tone: "success", title: "WhatsApp disconnected" });
    },
    onError: (err) => {
      if (isReauthCancelled(err)) return;
      toast({ tone: "error", title: "Could not disconnect", description: errorMessage(err) });
    },
  });

  const status = account.data;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <MessageCircle className="size-4 text-primary" aria-hidden /> Business account
            </CardTitle>
            <CardDescription>One WhatsApp Business number per workspace, shared by everyone with the WhatsApp permission.</CardDescription>
          </div>
          {status ? status.connected ? <Badge variant="success">Connected</Badge> : <Badge variant="warning">Not connected</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {account.isPending ? (
          <SkeletonRows rows={2} />
        ) : account.isError ? (
          <p className="text-sm text-danger">{errorMessage(account.error)}</p>
        ) : status?.connected ? (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-fg-subtle">Display name</dt>
              <dd>{status.display_name || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-subtle">Phone number</dt>
              <dd>{status.display_phone || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-subtle">Phone number ID</dt>
              <dd className="font-mono text-xs">{status.phone_number_id || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-subtle">Connected</dt>
              <dd>{formatDateTime(status.connected_at)}</dd>
            </div>
          </dl>
        ) : canManage ? (
          <form
            onSubmit={form.handleSubmit((v) => {
              setFieldErrors({});
              connect.mutate(v);
            })}
            className="grid gap-4"
            noValidate
          >
            <p className="text-sm text-fg-muted">
              Copy these values from Meta Business Manager → WhatsApp → API setup. Use a permanent system-user token; it is stored encrypted and never displayed again.
            </p>
            <FormError message={fieldErrors.non_field_errors} />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField control={form.control} name="phone_number_id" label="Phone number ID" serverError={fieldErrors.phone_number_id}>
                {(f) => <Input {...f} inputMode="numeric" autoComplete="off" value={f.value} onChange={(e) => f.onChange(e.target.value)} />}
              </FormField>
              <FormField control={form.control} name="business_account_id" label="Business account ID (optional)" serverError={fieldErrors.business_account_id}>
                {(f) => <Input {...f} inputMode="numeric" autoComplete="off" value={f.value} onChange={(e) => f.onChange(e.target.value)} />}
              </FormField>
            </div>
            <FormField control={form.control} name="access_token" label="Access token" serverError={fieldErrors.access_token}>
              {(f) => <Input {...f} type="password" autoComplete="off" value={f.value} onChange={(e) => f.onChange(e.target.value)} />}
            </FormField>
            <div>
              <Button type="submit" loading={connect.isPending}>
                Connect WhatsApp
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-sm text-fg-muted">WhatsApp is not connected. Ask an administrator to connect the Business account.</p>
        )}
      </CardContent>
      {status?.connected && canManage ? (
        <CardFooter className="justify-end">
          <Button variant="danger-ghost" onClick={() => setConfirmDisconnect(true)}>
            Disconnect
          </Button>
        </CardFooter>
      ) : null}
      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title="Disconnect WhatsApp?"
        description="Nobody will be able to send or receive WhatsApp messages from the CRM until it is connected again. Conversation history stays on the records."
        confirmLabel="Disconnect"
        destructive
        loading={disconnect.isPending}
        onConfirm={() => disconnect.mutate()}
      />
    </Card>
  );
}

function WebhookCard() {
  const { toast } = useToast();
  const account = useQuery({ queryKey: crmKeys.whatsappAccount, queryFn: getWhatsAppAccount });
  const [origin, setOrigin] = React.useState("");
  React.useEffect(() => setOrigin(window.location.origin), []);
  const url = `${origin}${WHATSAPP_WEBHOOK_PATH}`;
  const configured = account.data?.webhook_configured ?? false;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ tone: "success", title: "Webhook URL copied" });
    } catch {
      toast({ tone: "error", title: "Copy failed", description: "Select the URL and copy it manually." });
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Webhook className="size-4 text-primary" aria-hidden /> Webhook
            </CardTitle>
            <CardDescription>Meta delivers incoming messages and delivery receipts to this address.</CardDescription>
          </div>
          {account.data ? configured ? <Badge variant="success">Configured</Badge> : <Badge variant="warning">Not configured</Badge> : null}
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex items-center gap-2">
          <code className="flex-1 break-all rounded-sm bg-bg-subtle px-2 py-1.5 font-mono text-xs">{url}</code>
          <Button variant="ghost" size="icon-sm" aria-label="Copy webhook URL" onClick={copy}>
            <Copy />
          </Button>
        </div>
        <ol className="grid gap-1 text-sm text-fg-muted">
          <li>1. In Meta Business Manager open WhatsApp → Configuration → Webhooks.</li>
          <li>2. Paste the callback URL above and the verify token your administrator set in the server configuration.</li>
          <li>3. Subscribe to the <span className="font-mono text-xs">messages</span> field so replies and delivery status reach the CRM.</li>
        </ol>
        {!configured ? <p className="text-xs text-fg-subtle">Until the webhook is verified, sent messages will stay “Sent” and customer replies will not appear.</p> : null}
      </CardContent>
    </Card>
  );
}
