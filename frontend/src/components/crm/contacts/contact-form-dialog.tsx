"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AddressFields, cleanAddress } from "@/components/crm/address-fields";
import { CustomFieldsForm, useCustomFields } from "@/components/crm/custom-fields-form";
import { OwnerSelect } from "@/components/crm/owner-select";
import { isVersionConflict, useInvalidateRecord } from "@/components/crm/use-record-mutations";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input, Textarea } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { createContact, getContact, listCompanies, updateContact } from "@/lib/api/crm";
import type { Address, Contact, ContactInput, CustomData, NamedRef } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { canReassign } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";

const NONE = "__none__";
const EMAIL = z.email();

const schema = z
  .object({
    first_name: z.string().trim().max(80, "First name is too long."),
    last_name: z.string().trim().max(80, "Last name is too long."),
    email: z
      .string()
      .trim()
      .max(254, "Email is too long.")
      .refine((v) => v === "" || EMAIL.safeParse(v).success, "Enter a valid email address."),
    phone: z.string().trim().max(32, "Phone is too long."),
    job_title: z.string().trim().max(120, "Job title is too long."),
    company_id: z.string(),
    source: z.string().trim().max(60, "Source is too long."),
    description: z.string().max(5000, "Description is too long."),
    owner_id: z.string(),
  })
  .refine((v) => v.first_name || v.last_name || v.email, { message: "Provide a first name, last name or email.", path: ["first_name"] });
type FormValues = z.infer<typeof schema>;

function defaults(contact: Contact | null, membershipId: string | undefined): FormValues {
  return {
    first_name: contact?.first_name ?? "",
    last_name: contact?.last_name ?? "",
    email: contact?.email ?? "",
    phone: contact?.phone ?? "",
    job_title: contact?.job_title ?? "",
    company_id: contact?.company?.id ?? NONE,
    source: contact?.source ?? "",
    description: contact?.description ?? "",
    owner_id: contact?.owner?.id ?? membershipId ?? "",
  };
}

function toPayload(values: FormValues, address: Address, customData: CustomData, includeOwner: boolean): ContactInput {
  const payload: ContactInput = {
    first_name: values.first_name,
    last_name: values.last_name,
    email: values.email,
    phone: values.phone,
    job_title: values.job_title,
    company_id: values.company_id === NONE ? null : values.company_id,
    source: values.source,
    address: cleanAddress(address),
    description: values.description,
    custom_data: customData,
  };
  if (includeOwner && values.owner_id) payload.owner_id = values.owner_id;
  return payload;
}

/** Create/edit dialog for a contact. Pass `contact` to edit; the current `version` is sent on save. */
export function ContactFormDialog({
  open,
  onOpenChange,
  contact = null,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact?: Contact | null;
  onSaved?: (saved: Contact) => void;
}) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const reassign = canReassign(active, "contacts");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const invalidate = useInvalidateRecord("contact");
  const { definitions } = useCustomFields("contact");

  const [fresh, setFresh] = React.useState<Contact | null>(null);
  const existing = fresh ?? contact;
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [customData, setCustomData] = React.useState<CustomData>({});
  const [address, setAddress] = React.useState<Address>({});
  const [conflict, setConflict] = React.useState(false);
  const [reloading, setReloading] = React.useState(false);

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: defaults(null, active?.membership_id) });

  const load = React.useCallback(
    (record: Contact | null) => {
      form.reset(defaults(record, active?.membership_id));
      setCustomData(record?.custom_data ?? {});
      setAddress(record?.address ?? {});
      setFieldErrors({});
      setConflict(false);
    },
    [form, active?.membership_id],
  );

  React.useEffect(() => {
    if (open) {
      setFresh(null);
      load(contact);
    }
  }, [open, contact, load]);

  const companies = useQuery({
    queryKey: ["crm", "companies", "picker"],
    queryFn: () => listCompanies({ sort: "name" }),
    enabled: open,
    staleTime: 60_000,
  });
  const companyOptions = React.useMemo<NamedRef[]>(() => {
    const options = companies.data?.results.map((c) => ({ id: c.id, name: c.name })) ?? [];
    const current = existing?.company;
    return current && !options.some((o) => o.id === current.id) ? [current, ...options] : options;
  }, [companies.data, existing?.company]);

  const mutation = useMutation({
    mutationFn: (values: FormValues) => {
      const payload = toPayload(values, address, customData, reassign);
      return existing ? updateContact(existing.id, existing.version, payload) : createContact(payload);
    },
    onSuccess: async (saved) => {
      await invalidate(saved.id);
      toast({ tone: "success", title: existing ? "Contact updated" : "Contact created", description: saved.display_name || saved.email });
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
        setFieldErrors(err.fieldErrors());
        return;
      }
      toast({ tone: "error", title: "Could not save contact", description: errorMessage(err) });
    },
  });

  const reload = async () => {
    if (!existing) return;
    setReloading(true);
    try {
      const latest = await queryClient.fetchQuery({
        queryKey: crmKeys.record("contacts", existing.id),
        queryFn: () => getContact(existing.id),
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
            <DialogTitle>{existing ? "Edit contact" : "New contact"}</DialogTitle>
            <DialogDescription>
              {existing ? "Update the details of this person." : "Add a person you work with. A name or an email is enough to start."}
            </DialogDescription>
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
            <FormField control={form.control} name="first_name" label="First name" serverError={fieldErrors.first_name}>
              {(field) => (
                <Input {...field} autoFocus autoComplete="off" maxLength={80} value={field.value} onChange={(e) => field.onChange(e.target.value)} />
              )}
            </FormField>
            <FormField control={form.control} name="last_name" label="Last name" serverError={fieldErrors.last_name}>
              {(field) => <Input {...field} autoComplete="off" maxLength={80} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
            </FormField>
            <FormField control={form.control} name="email" label="Email" serverError={fieldErrors.email}>
              {(field) => (
                <Input {...field} type="email" autoComplete="off" maxLength={254} value={field.value} onChange={(e) => field.onChange(e.target.value)} />
              )}
            </FormField>
            <FormField control={form.control} name="phone" label="Phone" serverError={fieldErrors.phone}>
              {(field) => (
                <Input {...field} type="tel" autoComplete="off" maxLength={32} value={field.value} onChange={(e) => field.onChange(e.target.value)} />
              )}
            </FormField>
            <FormField control={form.control} name="job_title" label="Job title" serverError={fieldErrors.job_title}>
              {(field) => <Input {...field} maxLength={120} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
            </FormField>
            <FormField control={form.control} name="company_id" label="Company" serverError={fieldErrors.company_id}>
              {(field) => (
                <Select value={field.value} onValueChange={field.onChange} disabled={companies.isPending}>
                  <SelectTrigger id={field.id} aria-invalid={field["aria-invalid"]} aria-describedby={field["aria-describedby"]}>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>None</SelectItem>
                    {companyOptions.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <FormField
              control={form.control}
              name="source"
              label="Source"
              description="Where this contact came from, e.g. Referral or Website."
              serverError={fieldErrors.source}
            >
              {(field) => <Input {...field} maxLength={60} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
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

          <AddressFields value={address} onChange={setAddress} errors={fieldErrors} disabled={mutation.isPending} />
          <CustomFieldsForm definitions={definitions} value={customData} onChange={setCustomData} errors={fieldErrors} disabled={mutation.isPending} />

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {existing ? "Save changes" : "Create contact"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
