"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Building2, Plus } from "lucide-react";
import { z } from "zod";
import { Badge, roleBadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { createOrganization, switchOrganization } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { CURRENCIES, timezoneOptions } from "@/lib/reference-data";
import { DEFAULT_NEXT } from "@/lib/safe-next";
import { useSession } from "@/lib/session";
import { organizationNameSchema } from "@/lib/validation";

/**
 * Every account gets its own workspace automatically. This card is where multi-organization
 * setups are managed: switch between the organizations you belong to, or create another one.
 */
export function OrganizationsCard() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: session } = useSession();
  const [createOpen, setCreateOpen] = React.useState(false);
  const memberships = session?.memberships ?? [];
  const activeId = session?.active?.membership_id;

  const switchMutation = useMutation({
    mutationFn: switchOrganization,
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      router.push(DEFAULT_NEXT);
    },
    onError: (err) => toast({ tone: "error", title: "Could not switch organization", description: errorMessage(err) }),
  });

  return (
    <Card className="mt-6">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Your organizations</CardTitle>
            <CardDescription>Organizations you belong to. Switching changes everything you see in the CRM.</CardDescription>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus /> New organization
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-2">
        {memberships.map((m) => {
          const isActive = m.id === activeId;
          return (
            <div key={m.id} className="flex items-center gap-3 rounded-sm border border-border px-3 py-2">
              <Building2 className="size-4 text-fg-subtle" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{m.organization.name}</span>
                <span className="block text-xs text-fg-subtle">{isActive ? "Current" : m.status === "active" ? "Available" : m.status}</span>
              </span>
              <Badge variant={roleBadgeVariant(m.role.key)}>{m.role.name}</Badge>
              {!isActive ? (
                <Button variant="ghost" size="sm" disabled={m.status !== "active" || switchMutation.isPending} onClick={() => switchMutation.mutate(m.id)}>
                  Open
                </Button>
              ) : null}
            </div>
          );
        })}
      </CardContent>
      <CreateOrganizationDialog open={createOpen} onOpenChange={setCreateOpen} />
    </Card>
  );
}

const schema = z.object({
  name: organizationNameSchema,
  base_currency: z.string().length(3, "Choose a currency."),
  timezone: z.string().min(1, "Choose a time zone."),
});
type Input_ = z.infer<typeof schema>;

export function CreateOrganizationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const timezones = React.useMemo(timezoneOptions, []);
  const current = session?.active?.organization;

  const form = useForm<Input_>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", base_currency: current?.base_currency ?? "USD", timezone: current?.timezone ?? "UTC" },
  });

  const currencyOptions = React.useMemo(() => {
    const code = current?.base_currency;
    return code && !CURRENCIES.some((c) => c.code === code) ? [{ code, name: code }, ...CURRENCIES] : CURRENCIES;
  }, [current?.base_currency]);
  const tzOptions = React.useMemo(() => {
    const tz = current?.timezone;
    return tz && !timezones.includes(tz) ? [tz, ...timezones] : timezones;
  }, [current?.timezone, timezones]);

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    setFieldErrors({});
    try {
      await createOrganization(values); // the backend activates the new membership itself
      await queryClient.invalidateQueries();
      onOpenChange(false);
      router.push(DEFAULT_NEXT);
    } catch (err) {
      if (isApiError(err) && err.isValidation) setFieldErrors(err.fieldErrors());
      setError(errorMessage(err, "Could not create the organization."));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>New organization</DialogTitle>
            <DialogDescription>You become its owner. It starts with a ready-to-use sales pipeline.</DialogDescription>
          </DialogHeader>
          <FormError message={error} />
          <FormField control={form.control} name="name" label="Organization name" serverError={fieldErrors.name}>
            {(field) => <Input {...field} autoFocus placeholder="Acme Inc." value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField control={form.control} name="base_currency" label="Base currency" serverError={fieldErrors.base_currency}>
              {(field) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id={field.id} aria-invalid={field["aria-invalid"]} aria-describedby={field["aria-describedby"]}>
                    <SelectValue placeholder="Currency" />
                  </SelectTrigger>
                  <SelectContent>
                    {currencyOptions.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.code} · {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <FormField control={form.control} name="timezone" label="Time zone" serverError={fieldErrors.timezone}>
              {(field) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id={field.id} aria-invalid={field["aria-invalid"]} aria-describedby={field["aria-describedby"]}>
                    <SelectValue placeholder="Time zone" />
                  </SelectTrigger>
                  <SelectContent>
                    {tzOptions.map((tz) => (
                      <SelectItem key={tz} value={tz}>
                        {tz}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={form.formState.isSubmitting}>
              Create organization
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
