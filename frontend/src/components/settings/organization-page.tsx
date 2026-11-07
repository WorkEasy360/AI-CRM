"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import "@/lib/zod-config";
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
import { getCurrentOrganization, removeOrganizationLogo, updateCurrentOrganization, uploadOrganizationLogo } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/problem";
import type { Organization } from "@/lib/api/types";
import { CURRENCIES, timezoneOptions } from "@/lib/reference-data";
import { hasPermission, queryKeys, useSession } from "@/lib/session";
import { DATE_FORMATS, formatDate } from "@/lib/utils";
import { organizationNameSchema } from "@/lib/validation";
import { OrganizationsCard } from "@/components/settings/organizations-card";

const schema = z.object({
  name: organizationNameSchema,
  base_currency: z.string().length(3, "Choose a currency."),
  timezone: z.string().min(1, "Choose a time zone."),
  require_mfa: z.boolean(),
  crm_name: z.string().trim().max(60, "Use at most 60 characters."),
  date_format: z.enum(DATE_FORMATS),
});
type Input_ = z.infer<typeof schema>;

const LOGO_SRC = "/brand/logo.png";

/** What each format looks like, shown beside the option. */
const FORMAT_EXAMPLE: Record<(typeof DATE_FORMATS)[number], string> = {
  "DD MMM YYYY": "05 Nov 2026",
  "DD/MM/YYYY": "05/11/2026",
  "MM/DD/YYYY": "11/05/2026",
  "YYYY-MM-DD": "2026-11-05",
};

function formValues(org: Organization): Input_ {
  const format = (DATE_FORMATS as readonly string[]).includes(org.date_format ?? "") ? (org.date_format as Input_["date_format"]) : "DD MMM YYYY";
  return { name: org.name, base_currency: org.base_currency, timezone: org.timezone, require_mfa: Boolean(org.require_mfa), crm_name: org.crm_name ?? "", date_format: format };
}

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
    defaultValues: { name: "", base_currency: "USD", timezone: "UTC", require_mfa: false, crm_name: "", date_format: "DD MMM YYYY" },
  });

  const loaded = org.data as Organization | undefined;
  React.useEffect(() => {
    if (loaded) form.reset(formValues(loaded));
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
    <div>
      <PageHeader title="General Settings" />

      {/* The form takes the wide column; the logo and organization cards sit beside it on large screens. */}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
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
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField control={form.control} name="name" label="Company name" serverError={fieldErrors.name}>
                  {(field) => <Input {...field} disabled={!canUpdate} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
                </FormField>
                <FormField control={form.control} name="crm_name" label="CRM name" serverError={fieldErrors.crm_name} description="Shown at the top of the sidebar.">
                  {(field) => <Input {...field} disabled={!canUpdate} value={field.value} placeholder="WorkEasyCRM" maxLength={60} onChange={(e) => field.onChange(e.target.value)} />}
                </FormField>
              </div>
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
                <FormField control={form.control} name="date_format" label="Date format" serverError={fieldErrors.date_format}>
                  {(field) => (
                    <Select value={field.value} onValueChange={field.onChange} disabled={!canUpdate}>
                      <SelectTrigger id={field.id} aria-invalid={field["aria-invalid"]} aria-describedby={field["aria-describedby"]}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DATE_FORMATS.map((f) => (
                          <SelectItem key={f} value={f}>
                            {f} (e.g. {FORMAT_EXAMPLE[f]})
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
                <Button type="button" variant="secondary" onClick={() => loaded && form.reset(formValues(loaded))} disabled={!form.formState.isDirty}>
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
      <div className="grid gap-5">
        {loaded ? <LogoCard org={loaded} canUpdate={canUpdate} /> : null}
        <OrganizationsCard />
      </div>
      </div>
    </div>
  );
}

/** Workspace logo for the sidebar: PNG, JPEG or WebP up to 512 KB; the server checks the bytes. */
function LogoCard({ org, canUpdate }: { org: Organization; canUpdate: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const done = async (title: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.organization }),
      queryClient.invalidateQueries({ queryKey: queryKeys.session }),
    ]);
    toast({ tone: "success", title });
  };
  const fail = (err: unknown) => {
    if (!isReauthCancelled(err)) toast({ tone: "error", title: "Could not change the logo", description: errorMessage(err) });
  };
  const upload = useMutation({ mutationFn: (file: File) => runSensitive(() => uploadOrganizationLogo(file)), onSuccess: () => done("Logo updated"), onError: fail });
  const remove = useMutation({ mutationFn: () => runSensitive(() => removeOrganizationLogo()), onSuccess: () => done("Logo removed"), onError: fail });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Logo</CardTitle>
        <CardDescription>PNG, JPEG or WebP, up to 512 KB.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-4">
        <span className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface">
          {/* eslint-disable-next-line @next/next/no-img-element -- a same-origin image behind the session, not optimisable */}
          <img src={org.logo_url ?? LOGO_SRC} alt={org.logo_url ? `${org.name} logo` : "Default logo"} className={org.logo_url ? "size-full object-contain" : "size-10 object-contain"} />
        </span>
        {canUpdate ? (
          <div className="flex flex-wrap gap-2">
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              aria-label="Choose a logo image"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                if (file.size > 512 * 1024) {
                  toast({ tone: "error", title: "That image is too large", description: "Choose an image of at most 512 KB." });
                  return;
                }
                upload.mutate(file);
              }}
            />
            <Button type="button" variant="secondary" size="sm" loading={upload.isPending} onClick={() => inputRef.current?.click()}>
              Upload logo
            </Button>
            {org.logo_url ? (
              <Button type="button" variant="ghost" size="sm" loading={remove.isPending} onClick={() => remove.mutate()}>
                Remove
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
