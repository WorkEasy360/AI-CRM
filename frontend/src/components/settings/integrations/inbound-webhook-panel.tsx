"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCw, Webhook } from "lucide-react";
import { isReauthCancelled, useReauth } from "@/components/reauth-provider";
import { CodeBlock, SecretRevealDialog, type SecretReveal } from "@/components/settings/integrations/secret-reveal-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { enableInboundWebhook, integrationKeys, rotateInboundSecret, type ConnectionDetail } from "@/lib/api/integrations";
import { errorMessage } from "@/lib/api/problem";

export const INBOUND_SIGNATURE_EXAMPLE = `POST <webhook URL>
Content-Type: application/json
Keel-Event-Id: <unique id for this event>
Keel-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>." + raw body)>

{"type": "contact.upsert", "data": {"id": "<external id>", ...mapped fields}}`;

function DeveloperNote() {
  return (
    <div className="grid gap-2">
      <p className="text-sm font-medium">For the developer of the sending system</p>
      <CodeBlock label="Inbound webhook request format">{INBOUND_SIGNATURE_EXAMPLE}</CodeBlock>
      <ul className="grid gap-1 text-xs text-fg-subtle">
        <li>
          Event types: <span className="font-mono">contact.upsert</span>, <span className="font-mono">company.upsert</span>, <span className="font-mono">deal.upsert</span>.
        </li>
        <li>Sign the exact raw request body; the timestamp must be within 5 minutes of the current time. Reuse the same event ID when retrying so Keel applies the event only once.</li>
        <li>Only data shared as External → CRM or Two-way is applied, and only through the fields you mapped.</li>
      </ul>
    </div>
  );
}

export function InboundWebhookPanel({ connection, canManage }: { connection: ConnectionDetail; canManage: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  // The only place the URL and secret ever live on the client. Dropped when the dialog closes.
  const [reveal, setReveal] = React.useState<SecretReveal | null>(null);
  const [confirmRecreate, setConfirmRecreate] = React.useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: integrationKeys.connection(connection.id) });
  const fail = (title: string) => (err: unknown) => {
    if (isReauthCancelled(err)) return;
    toast({ tone: "error", title, description: errorMessage(err) });
  };

  const enable = useMutation({
    mutationFn: async () => {
      const { url, secret } = await runSensitive(() => enableInboundWebhook(connection.id));
      // Hand the values to transient state; the mutation result itself stays empty so no cache ever holds them.
      setReveal({
        title: "Inbound webhook enabled",
        description: "Give the URL and signing secret to the system that will send data to Keel.",
        items: [
          { label: "Webhook URL", value: url },
          { label: "Signing secret", value: secret },
        ],
        warning: "Copy the URL and secret now. For your security they will not be shown again.",
        children: <DeveloperNote />,
      });
    },
    onSuccess: async () => {
      setConfirmRecreate(false);
      await refresh();
    },
    onError: fail("Could not enable the inbound webhook"),
  });

  const rotate = useMutation({
    mutationFn: async () => {
      const { secret } = await runSensitive(() => rotateInboundSecret(connection.id));
      setReveal({
        title: "New signing secret",
        description: "Update the sending system to sign requests with this secret.",
        items: [{ label: "Signing secret", value: secret }],
        warning: "Copy the secret now; it will not be shown again. The old secret keeps working for 24 hours so you can switch over.",
      });
    },
    onSuccess: refresh,
    onError: fail("Could not rotate the secret"),
  });

  const disconnected = connection.status === "disconnected";

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Webhook className="size-4 text-primary" aria-hidden /> Inbound webhook
            </CardTitle>
            <CardDescription>Let the external system push changes to Keel the moment they happen, instead of waiting for the next sync.</CardDescription>
          </div>
          {connection.inbound_enabled ? <Badge variant="success">Enabled</Badge> : <Badge variant="neutral">Not enabled</Badge>}
        </div>
      </CardHeader>
      <CardContent className="grid gap-5">
        {connection.inbound_enabled ? (
          <p className="text-sm text-fg-muted">
            The webhook URL and signing secret were shown once when the webhook was enabled. If the secret was lost or exposed, rotate it. If the URL was lost, create a new
            one; the old URL stops working immediately.
          </p>
        ) : (
          <p className="text-sm text-fg-muted">
            {disconnected
              ? "Reconnect this integration before enabling the inbound webhook."
              : "Keel creates a private URL and a signing secret for this connection. Requests without a valid signature are rejected. The secret is shown only once."}
          </p>
        )}
        <DeveloperNote />
      </CardContent>
      {canManage ? (
        <CardFooter className="flex-wrap justify-end">
          {connection.inbound_enabled ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setConfirmRecreate(true)}>
                Create new URL
              </Button>
              <Button variant="secondary" size="sm" onClick={() => rotate.mutate()} loading={rotate.isPending}>
                <RotateCw /> Rotate secret
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => enable.mutate()} loading={enable.isPending} disabled={disconnected}>
              Enable inbound webhook
            </Button>
          )}
        </CardFooter>
      ) : null}

      <ConfirmDialog
        open={confirmRecreate}
        onOpenChange={setConfirmRecreate}
        title="Create a new webhook URL?"
        description="The current URL and secret stop working immediately. Requests from the sending system will be rejected until it uses the new URL and secret."
        confirmLabel="Create new URL"
        destructive
        loading={enable.isPending}
        onConfirm={() => enable.mutate()}
      />
      <SecretRevealDialog reveal={reveal} onClose={() => setReveal(null)} />
    </Card>
  );
}
