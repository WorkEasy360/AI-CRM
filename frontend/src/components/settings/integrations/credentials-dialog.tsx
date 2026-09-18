"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { isReauthCancelled, useReauth } from "@/components/reauth-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { integrationKeys, updateConnectionCredentials, type ConnectionCredentials, type ConnectionDetail } from "@/lib/api/integrations";
import { errorMessage, isApiError } from "@/lib/api/problem";

type CredentialKey = keyof ConnectionCredentials;

function credentialField(authType: ConnectionDetail["auth_type"]): { key: CredentialKey; label: string; required: boolean } | null {
  switch (authType) {
    case "api_key":
      return { key: "api_key", label: "API key", required: true };
    case "bearer_token":
      return { key: "token", label: "Bearer token", required: true };
    case "oauth2_code":
    case "oauth2_client_credentials":
      return { key: "client_secret", label: "Client secret", required: false };
    default:
      return null;
  }
}

/** Replace stored credentials (or reconnect a webhook-only connection). Typed values are cleared on close. */
export function CredentialsDialog({ connection, open, onOpenChange }: { connection: ConnectionDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  const [value, setValue] = React.useState("");
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [generalError, setGeneralError] = React.useState<string | null>(null);
  const field = credentialField(connection.auth_type);
  const inputId = React.useId();

  const mutation = useMutation({
    // The secret is a mutation variable: remove the mutation from the cache once nothing observes it.
    gcTime: 0,
    mutationFn: (credentials: ConnectionCredentials) => runSensitive(() => updateConnectionCredentials(connection.id, credentials)),
    onSuccess: async (detail) => {
      queryClient.setQueryData(integrationKeys.connection(connection.id), detail);
      await queryClient.invalidateQueries({ queryKey: integrationKeys.catalog });
      toast(
        detail.auth_type === "oauth2_code"
          ? { tone: "success", title: "Credentials updated", description: "Connect with OAuth to finish reconnecting." }
          : { tone: "success", title: "Credentials updated", description: detail.status_message },
      );
      handleOpenChange(false);
    },
    onError: (err) => {
      setValue("");
      if (isReauthCancelled(err)) return;
      if (isApiError(err) && err.isValidation) {
        const errors = err.fieldErrors();
        const own = field ? errors[`credentials.${field.key}`] : undefined;
        setFieldError(own ?? null);
        const rest = Object.entries(errors)
          .filter(([key]) => !field || key !== `credentials.${field.key}`)
          .map(([, message]) => message);
        setGeneralError(rest.length ? rest.join(" ") : null);
        return;
      }
      toast({ tone: "error", title: "Could not update credentials", description: errorMessage(err) });
    },
  });

  function handleOpenChange(next: boolean) {
    if (!next) {
      setValue("");
      setFieldError(null);
      setGeneralError(null);
      mutation.reset();
    }
    onOpenChange(next);
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setFieldError(null);
    setGeneralError(null);
    if (field?.required && !value) {
      setFieldError(`Enter the ${field.label.toLowerCase()}.`);
      return;
    }
    mutation.mutate(field && value ? { [field.key]: value } : {});
  };

  const reconnectOnly = field === null;
  const errorId = `${inputId}-error`;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{reconnectOnly ? "Reconnect" : connection.status === "disconnected" ? "Reconnect with new credentials" : "Update credentials"}</DialogTitle>
            <DialogDescription>
              {reconnectOnly
                ? "Turn this webhook-only connection back on. Enable the inbound webhook again afterwards to get a new URL and secret."
                : connection.auth_type === "oauth2_code"
                  ? "Save the client secret, then connect with OAuth again to authorize Keel."
                  : "The new value replaces the stored one. It is stored encrypted and never shown again."}
            </DialogDescription>
          </DialogHeader>
          <FormError message={generalError} />
          {field ? (
            <div className="grid gap-1.5">
              <Label htmlFor={inputId}>{field.label}</Label>
              <Input
                id={inputId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                aria-invalid={fieldError ? true : undefined}
                aria-describedby={fieldError ? errorId : undefined}
                aria-required={field.required || undefined}
              />
              {fieldError ? (
                <p id={errorId} role="alert" className="text-xs text-danger">
                  {fieldError}
                </p>
              ) : !field.required ? (
                <p className="text-xs text-fg-subtle">Leave blank if the provider does not issue a client secret.</p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {reconnectOnly ? "Reconnect" : "Save credentials"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
