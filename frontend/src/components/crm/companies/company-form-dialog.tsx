"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AddressFields, cleanAddress } from "@/components/crm/address-fields";
import { Disclosure } from "@/components/crm/contacts/record-layout";
import { CustomFieldsForm, useCustomFields } from "@/components/crm/custom-fields-form";
import { CompanyDuplicateCheck } from "@/components/crm/duplicate-warning";
import { LifecycleSelect } from "@/components/crm/lifecycle-select";
import { OwnerSelect } from "@/components/crm/owner-select";
import { isVersionConflict, useInvalidateRecord } from "@/components/crm/use-record-mutations";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input, Textarea } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { createCompany, getCompany, updateCompany } from "@/lib/api/crm";
import { COMPANY_SIZES, LIFECYCLE_STAGES, type Address, type Company, type CompanyInput, type CustomData } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { canReassign } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";

const NONE = "__none__";
const DECIMAL = /^\d{1,16}(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

const schema = z.object({
  name: z.string().trim().min(1, "Company name is required.").max(160, "Name is too long."),
  website: z.string().trim().max(2048, "Website is too long."),
  phone: z.string().trim().max(32, "Phone is too long."),
  industry: z.string().trim().max(80, "Industry is too long."),
  lifecycle_stage: z.enum(LIFECYCLE_STAGES),
  company_size: z.string(),
  annual_revenue: z
    .string()
    .trim()
    .refine((v) => v === "" || DECIMAL.test(v), "Enter an amount with up to two decimals."),
  revenue_currency: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === "" || CURRENCY.test(v), "Use a 3-letter currency code, e.g. USD."),
  source: z.string().trim().max(60, "Source is too long."),
  description: z.string().max(5000, "Description is too long."),
  owner_id: z.string(),
});
type FormValues = z.infer<typeof schema>;

const BASIC_FIELDS = ["name", "website", "phone", "industry", "lifecycle_stage"];

/** True when any "More details" field carries a value (used to expand the section on edit). */
function hasDetails(company: Company | null): boolean {
  if (!company) return false;
  return Boolean(
    company.company_size ||
      company.annual_revenue ||
      company.source ||
      company.description ||
      Object.values(company.address ?? {}).some(Boolean) ||
      Object.values(company.custom_data ?? {}).some((v) => v !== null && v !== "" && v !== undefined),
  );
}

function defaults(company: Company | null, membershipId: string | undefined): FormValues {
  return {
    name: company?.name ?? "",
    website: company?.website ?? "",
    phone: company?.phone ?? "",
    industry: company?.industry ?? "",
    lifecycle_stage: company?.lifecycle_stage ?? "lead",
    company_size: company?.company_size || NONE,
    annual_revenue: company?.annual_revenue ?? "",
    revenue_currency: company?.revenue_currency ?? "",
    source: company?.source ?? "",
    description: company?.description ?? "",
    owner_id: company?.owner?.id ?? membershipId ?? "",
  };
}

function toPayload(values: FormValues, address: Address, customData: CustomData, includeOwner: boolean, editing: boolean): CompanyInput {
  const payload: CompanyInput = {
    name: values.name,
    website: values.website,
    phone: values.phone,
    industry: values.industry,
    company_size: values.company_size === NONE ? "" : values.company_size,
    revenue_currency: values.revenue_currency,
    source: values.source,
    address: cleanAddress(address),
    description: values.description,
    custom_data: customData,
    lifecycle_stage: values.lifecycle_stage,
  };
  // Numbers: omit when empty on create; send null on edit so a cleared field really clears.
  if (values.annual_revenue) payload.annual_revenue = values.annual_revenue;
  else if (editing) payload.annual_revenue = null;
  if (includeOwner && values.owner_id) payload.owner_id = values.owner_id;
  return payload;
}

/** Create/edit dialog for a company. Pass `company` to edit; the current `version` is sent on save. */
export function CompanyFormDialog({
  open,
  onOpenChange,
  company = null,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  company?: Company | null;
  onSaved?: (saved: Company) => void;
}) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const reassign = canReassign(active, "companies");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const invalidate = useInvalidateRecord("company");
  const { definitions } = useCustomFields("company");

  const [fresh, setFresh] = React.useState<Company | null>(null);
  const existing = fresh ?? company;
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [customData, setCustomData] = React.useState<CustomData>({});
  const [address, setAddress] = React.useState<Address>({});
  const [conflict, setConflict] = React.useState(false);
  const [reloading, setReloading] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(false);

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: defaults(null, active?.membership_id) });

  const load = React.useCallback(
    (record: Company | null) => {
      form.reset(defaults(record, active?.membership_id));
      setCustomData(record?.custom_data ?? {});
      setAddress(record?.address ?? {});
      setFieldErrors({});
      setConflict(false);
      setMoreOpen(hasDetails(record));
    },
    [form, active?.membership_id],
  );

  React.useEffect(() => {
    if (open) {
      setFresh(null);
      load(company);
    }
  }, [open, company, load]);

  // Duplicate hints: always on create; on edit only once the name or website differs from the saved record.
  const [name, website] = useWatch({ control: form.control, name: ["name", "website"] });
  const identityChanged = !existing || name !== existing.name || website !== existing.website;

  const mutation = useMutation({
    mutationFn: (values: FormValues) => {
      const payload = toPayload(values, address, customData, reassign, existing !== null);
      return existing ? updateCompany(existing.id, existing.version, payload) : createCompany(payload);
    },
    onSuccess: async (saved) => {
      await invalidate(saved.id);
      toast({ tone: "success", title: existing ? "Company updated" : "Company created", description: saved.name });
      onSaved?.(saved);
      onOpenChange(false);
    },
    onError: (err) => {
      if (isVersionConflict(err)) {
        setConflict(true);
        toast({ tone: "error", title: "This record was changed by someone else", description: "Reload the form to pick up the latest version." });
        return;
      }
      if (isApiError(err) && err.isValidation) {
        const errors = err.fieldErrors();
        setFieldErrors(errors);
        if (Object.keys(errors).some((k) => !BASIC_FIELDS.includes(k))) setMoreOpen(true);
        return;
      }
      toast({ tone: "error", title: "Could not save company", description: errorMessage(err) });
    },
  });

  const reload = async () => {
    if (!existing) return;
    setReloading(true);
    try {
      const latest = await queryClient.fetchQuery({
        queryKey: crmKeys.record("companies", existing.id),
        queryFn: () => getCompany(existing.id),
        staleTime: 0,
      });
      setFresh(latest);
      load(latest);
    } catch (err) {
      toast({ tone: "error", title: "Could not reload", description: errorMessage(err) });
    } finally {
      setReloading(false);
    }
  };

  const onSubmit = form.handleSubmit((values) => {
    setFieldErrors({});
    mutation.mutate(values);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={onSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>{existing ? "Edit company" : "New company"}</DialogTitle>
            <DialogDescription>{existing ? "Update the details of this account." : "Add an account you sell to. Only the name is required."}</DialogDescription>
          </DialogHeader>
          <FormError message={fieldErrors.non_field_errors ?? fieldErrors.version} />
          {conflict ? (
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning"
            >
              <span>This record was changed by someone else. Reload to see their changes before saving.</span>
              <Button type="button" size="sm" variant="secondary" onClick={reload} loading={reloading}>
                Reload
              </Button>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField control={form.control} name="name" label="Name" className="sm:col-span-2" serverError={fieldErrors.name}>
              {(field) => (
                <Input {...field} autoFocus autoComplete="organization" maxLength={160} value={field.value} onChange={(e) => field.onChange(e.target.value)} />
              )}
            </FormField>
            <FormField control={form.control} name="website" label="Website" serverError={fieldErrors.website}>
              {(field) => (
                <Input {...field} type="url" placeholder="https://" autoComplete="url" maxLength={2048} value={field.value} onChange={(e) => field.onChange(e.target.value)} />
              )}
            </FormField>
            <FormField control={form.control} name="phone" label="Phone" serverError={fieldErrors.phone}>
              {(field) => (
                <Input {...field} type="tel" autoComplete="off" maxLength={32} value={field.value} onChange={(e) => field.onChange(e.target.value)} />
              )}
            </FormField>
            <FormField control={form.control} name="industry" label="Industry" serverError={fieldErrors.industry}>
              {(field) => <Input {...field} maxLength={80} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
            </FormField>
            <FormField control={form.control} name="lifecycle_stage" label="Status" serverError={fieldErrors.lifecycle_stage}>
              {(field) => (
                <LifecycleSelect id={field.id} value={field.value} onChange={(v) => field.onChange(v || "lead")} ariaInvalid={field.invalid} ariaDescribedBy={field["aria-describedby"]} />
              )}
            </FormField>
            <CompanyDuplicateCheck className="sm:col-span-2" name={name ?? ""} website={website ?? ""} exclude={existing?.id} enabled={open && identityChanged} />
          </div>

          <Disclosure title="More details" summary="Size, revenue, source, owner, address…" open={moreOpen} onOpenChange={setMoreOpen}>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField control={form.control} name="company_size" label="Company size" serverError={fieldErrors.company_size}>
                {(field) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id={field.id} aria-invalid={field["aria-invalid"]} aria-describedby={field["aria-describedby"]}>
                      <SelectValue placeholder="Not set" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Not set</SelectItem>
                      {COMPANY_SIZES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {s} employees
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
              <FormField control={form.control} name="source" label="Source" serverError={fieldErrors.source}>
                {(field) => <Input {...field} maxLength={60} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
              </FormField>
              <FormField control={form.control} name="annual_revenue" label="Annual revenue" serverError={fieldErrors.annual_revenue}>
                {(field) => (
                  <Input {...field} inputMode="decimal" placeholder="0.00" maxLength={20} value={field.value} onChange={(e) => field.onChange(e.target.value)} />
                )}
              </FormField>
              <FormField control={form.control} name="revenue_currency" label="Revenue currency" serverError={fieldErrors.revenue_currency}>
                {(field) => (
                  <Input
                    {...field}
                    placeholder={active?.organization.base_currency ?? "USD"}
                    maxLength={3}
                    className="uppercase"
                    autoCapitalize="characters"
                    value={field.value}
                    onChange={(e) => field.onChange(e.target.value)}
                  />
                )}
              </FormField>
              {reassign ? (
                <FormField control={form.control} name="owner_id" label="Owner" serverError={fieldErrors.owner_id}>
                  {(field) => <OwnerSelect id={field.id} value={field.value} onChange={field.onChange} ariaInvalid={field.invalid} />}
                </FormField>
              ) : null}
              <FormField control={form.control} name="description" label="Description" className="sm:col-span-2" serverError={fieldErrors.description}>
                {(field) => <Textarea {...field} maxLength={5000} rows={3} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
              </FormField>
            </div>
            <div className="mt-4 grid gap-5">
              <AddressFields value={address} onChange={setAddress} errors={fieldErrors} disabled={mutation.isPending} />
              <CustomFieldsForm definitions={definitions} value={customData} onChange={setCustomData} errors={fieldErrors} disabled={mutation.isPending} />
            </div>
          </Disclosure>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {existing ? "Save changes" : "Create company"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
