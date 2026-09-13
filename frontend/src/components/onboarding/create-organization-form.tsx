"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, Building2, LogOut } from "lucide-react";
import { z } from "zod";
import { Badge, roleBadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { logout } from "@/lib/api/allauth";
import { createOrganization, switchOrganization } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { CURRENCIES, guessTimezone, timezoneOptions } from "@/lib/reference-data";
import { useSession } from "@/lib/session";
import { organizationNameSchema } from "@/lib/validation";

const schema = z.object({
  name: organizationNameSchema,
  base_currency: z.string().length(3, "Choose a currency."),
  timezone: z.string().min(1, "Choose a time zone."),
});
type Input_ = z.infer<typeof schema>;

export function CreateOrganizationForm() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const session = useSession();
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const timezones = React.useMemo(timezoneOptions, []);

  const form = useForm<Input_>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", base_currency: "USD", timezone: guessTimezone() },
  });

  const switchMutation = useMutation({
    mutationFn: switchOrganization,
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      router.replace("/dashboard");
    },
    onError: (err) => toast({ tone: "error", title: "Could not open organization", description: errorMessage(err) }),
  });

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.clear();
      router.replace("/login");
    },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    setFieldErrors({});
    try {
      const created = await createOrganization(values);
      if (created?.membership_id) {
        try {
          await switchOrganization(created.membership_id);
        } catch {
          /* the backend may already have activated the new membership */
        }
      }
      await queryClient.invalidateQueries();
      router.replace("/dashboard");
    } catch (err) {
      if (isApiError(err) && err.isValidation) setFieldErrors(err.fieldErrors());
      setError(errorMessage(err, "Could not create the organization."));
    }
  });

  const memberships = session.data?.memberships ?? [];

  return (
    <div className="grid w-full max-w-lg gap-6">
      {memberships.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Your organizations</CardTitle>
            <CardDescription>Pick one to continue, or create a new organization below.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {memberships.map((m) => (
              <button
                key={m.id}
                type="button"
                disabled={m.status !== "active" || switchMutation.isPending}
                onClick={() => switchMutation.mutate(m.id)}
                className="flex items-center gap-3 rounded-sm border border-border px-3 py-2 text-left hover:bg-bg-subtle disabled:opacity-60"
              >
                <Building2 className="size-4 text-fg-subtle" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{m.organization.name}</span>
                  <span className="block text-xs text-fg-subtle">{m.status === "active" ? "Active" : m.status}</span>
                </span>
                <Badge variant={roleBadgeVariant(m.role.key)}>{m.role.name}</Badge>
                <ArrowRight className="size-4 text-fg-subtle" aria-hidden />
              </button>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{memberships.length ? "Create another organization" : "Create your organization"}</CardTitle>
          <CardDescription>
            {memberships.length
              ? "You will become its owner."
              : "You are signed in but not a member of any organization yet. Create one to get started, or open an invitation link you received."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4" noValidate>
            <FormError message={error} />
            <FormField control={form.control} name="name" label="Organization name" serverError={fieldErrors.name}>
              {(field) => (
                <Input {...field} autoFocus placeholder="Acme Inc." value={field.value} onChange={(e) => field.onChange(e.target.value)} />
              )}
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField control={form.control} name="base_currency" label="Base currency" serverError={fieldErrors.base_currency}>
                {(field) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id={field.id} aria-invalid={field["aria-invalid"]} aria-describedby={field["aria-describedby"]}>
                      <SelectValue placeholder="Currency" />
                    </SelectTrigger>
                    <SelectContent>
                      {CURRENCIES.map((c) => (
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
                      {timezones.map((tz) => (
                        <SelectItem key={tz} value={tz}>
                          {tz}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
            </div>
            <Button type="submit" className="w-full" loading={form.formState.isSubmitting}>
              Create organization
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm text-fg-muted">
        <span className="truncate">Signed in as {session.data?.user.email}</span>
        <Button variant="ghost" size="sm" onClick={() => logoutMutation.mutate()} loading={logoutMutation.isPending}>
          <LogOut /> Sign out
        </Button>
      </div>
    </div>
  );
}
