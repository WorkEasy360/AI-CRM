"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { PageHeader } from "@/components/page-header";
import { isReauthCancelled, useReauth } from "@/components/reauth-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { getCurrentOrganization, updateCurrentOrganization } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/problem";
import type { Organization } from "@/lib/api/types";
import { CURRENCIES, timezoneOptions } from "@/lib/reference-data";
import { hasPermission, queryKeys, useSession } from "@/lib/session";
import { formatDate } from "@/lib/utils";
import { organizationNameSchema } from "@/lib/validation";
import { OrganizationsCard } from "@/components/settings/organizations-card";

const schema = z.object({
  name: organizationNameSchema,
  base_currency: z.string().length(3, "Choose a currency."),
  timezone: z.string().min(1, "Choose a time zone."),
  require_mfa: z.boolean(),
});
type Input_ = z.infer<typeof schema>;

export function OrganizationPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canUpdate = hasPermission(active, "org.update");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  const timezones = React.useMemo(timezoneOptions, []);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  const org = useQuery({
    queryKey: queryKeys.organization,
    queryFn: getCurrentOrganization,
    placeholderData: active?.organization,
  });

  const form = useForm<Input_>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", base_currency: "USD", timezone: "UTC", require_mfa: false },
  });

  const loaded = org.data as Organization | undefined;
  React.useEffect(() => {
    if (loaded) {
      form.reset({
        name: loaded.name,
        base_currency: loaded.base_currency,
        timezone: loaded.timezone,
        require_mfa: Boolean(loaded.require_mfa),
      });
    }
  }, [loaded, form]);

  const mutation = useMutation({
    mutationFn: (values: Input_) => runSensitive(() => updateCurrentOrganization(values)),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.organization }),
        queryClient.invalidateQueries({ queryKey: queryKeys.session }),
      ]);
      toast({ tone: "success", title: "Organization updated" });
    },
    onError: (err) => {
      if (isReauthCancelled(err)) return;
      if (isApiError(err) && err.isValidation) setFieldErrors(err.fieldErrors());
      else toast({ tone: "error", title: "Could not save changes", description: errorMessage(err) });
    },
  });

  const currencyOptions = React.useMemo(() => {
    const current = loaded?.base_currency;
    if (current && !CURRENCIES.some((c) => c.code === current)) return [{ code: current, name: current }, ...CURRENCIES];
    return CURRENCIES;
  }, [loaded?.base_currency]);

  const tzOptions = React.useMemo(() => {
    const current = loaded?.timezone;
    return current && !timezones.includes(current) ? [current, ...timezones] : timezones;
  }, [loaded?.timezone, timezones]);

  return (
    <div className="max-w-2xl">
      <PageHeader title="General" description="Name, defaults and security policy for this organization." />

      {org.isPending && !loaded ? (
        <SkeletonRows rows={4} />
      ) : (
        <form
          onSubmit={form.handleSubmit((v) => {
            setFieldErrors({});
            mutation.mutate(v);
          })}
          noValidate
        >
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle>General</CardTitle>
                  <CardDescription>
                    {loaded ? (
                      <>
                        Created {formatDate(loaded.created_at)} · slug <code className="font-mono text-xs">{loaded.slug}</code>
                      </>
                    ) : null}
                  </CardDescription>
                </div>
                {loaded ? (
                  <div className="flex gap-2">
                    <Badge variant="primary">{loaded.plan}</Badge>
                    <Badge variant={loaded.status === "active" ? "success" : "warning"}>{loaded.status}</Badge>
                  </div>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="grid gap-4">
              {!canUpdate ? (
                <p className="rounded-sm bg-bg-subtle px-3 py-2 text-xs text-fg-muted">
                  You can view these settings. Only owners and admins can change them.
                </p>
              ) : null}
              <FormError message={fieldErrors.non_field_errors} />
              <FormField control={form.control} name="name" label="Organization name" serverError={fieldErrors.name}>
                {(field) => <Input {...field} disabled={!canUpdate} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
              </FormField>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField control={form.control} name="base_currency" label="Base currency" serverError={fieldErrors.base_currency}>
                  {(field) => (
                    <Select value={field.value} onValueChange={field.onChange} disabled={!canUpdate}>
                      <SelectTrigger id={field.id} aria-invalid={field["aria-invalid"]} aria-describedby={field["aria-describedby"]}>
                        <SelectValue />
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
                    <Select value={field.value} onValueChange={field.onChange} disabled={!canUpdate}>
                      <SelectTrigger id={field.id} aria-invalid={field["aria-invalid"]} aria-describedby={field["aria-describedby"]}>
                        <SelectValue />
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
              <FormField
                control={form.control}
                name="require_mfa"
                serverError={fieldErrors.require_mfa}
                description="When enabled, every member must set up an authenticator app before they can use this organization."
              >
                {(field) => (
                  <div className="flex items-center justify-between gap-4 rounded-sm border border-border px-3 py-3">
                    <label htmlFor={field.id} className="text-sm font-medium">
                      Require two-factor authentication
                    </label>
                    <Switch id={field.id} checked={field.value} onCheckedChange={field.onChange} disabled={!canUpdate} aria-describedby={field["aria-describedby"]} />
                  </div>
                )}
              </FormField>
            </CardContent>
            {canUpdate ? (
              <CardFooter className="justify-end">
                <Button type="button" variant="secondary" onClick={() => loaded && form.reset({ ...loaded, require_mfa: Boolean(loaded.require_mfa) })} disabled={!form.formState.isDirty}>
                  Reset
                </Button>
                <Button type="submit" loading={mutation.isPending} disabled={!form.formState.isDirty}>
                  Save changes
                </Button>
              </CardFooter>
            ) : null}
          </Card>
        </form>
      )}
      <OrganizationsCard />
    </div>
  );
}
