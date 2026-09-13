"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AddressFields, cleanAddress } from "@/components/crm/address-fields";
import { Disclosure } from "@/components/crm/contacts/record-layout";
import { CustomFieldsForm, useCustomFields } from "@/components/crm/custom-fields-form";
import { ContactDuplicateCheck } from "@/components/crm/duplicate-warning";
import { LifecycleSelect } from "@/components/crm/lifecycle-select";
import { OwnerSelect } from "@/components/crm/owner-select";
import { isVersionConflict, useInvalidateRecord } from "@/components/crm/use-record-mutations";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { createContact, getContact, listCompanies, updateContact } from "@/lib/api/crm";
import { LIFECYCLE_STAGES, type Address, type Contact, type ContactInput, type CustomData, type NamedRef } from "@/lib/api/crm-types";
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
    company_id: z.string(),
    lifecycle_stage: z.enum(LIFECYCLE_STAGES),
    job_title: z.string().trim().max(120, "Job title is too long."),
    source: z.string().trim().max(60, "Source is too long."),
    description: z.string().max(5000, "Description is too long."),
    owner_id: z.string(),
    whatsapp_opt_in: z.boolean(),
  })
  .refine((v) => v.first_name || v.last_name || v.email, { message: "Provide a first name, last name or email.", path: ["first_name"] });
type FormValues = z.infer<typeof schema>;

export interface ContactFormDefaults {
  /** Preselect a company when creating from a company page. */
  company?: NamedRef | null;
}

function defaults(contact: Contact | null, membershipId: string | undefined, preset?: ContactFormDefaults): FormValues {
  return {
    first_name: contact?.first_name ?? "",
    last_name: contact?.last_name ?? "",
    email: contact?.email ?? "",
    phone: contact?.phone ?? "",
    company_id: contact?.company?.id ?? preset?.company?.id ?? NONE,
    lifecycle_stage: contact?.lifecycle_stage ?? "lead",
    job_title: contact?.job_title ?? "",
    source: contact?.source ?? "",
    description: contact?.description ?? "",
    owner_id: contact?.owner?.id ?? membershipId ?? "",
    whatsapp_opt_in: contact?.whatsapp_opt_in ?? false,
  };
}

/** True when any of the optional "More details" fields carries a value (used to expand it on edit). */
function hasDetails(contact: Contact | null): boolean {
  if (!contact) return false;
  return Boolean(
    contact.job_title ||
      contact.source ||
      contact.description ||
      contact.whatsapp_opt_in ||
      Object.values(contact.address ?? {}).some(Boolean) ||
      Object.values(contact.custom_data ?? {}).some((v) => v !== null && v !== "" && v !== undefined),
  );
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
    lifecycle_stage: values.lifecycle_stage,
    whatsapp_opt_in: values.whatsapp_opt_in,
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
  defaults: preset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact?: Contact | null;
  onSaved?: (saved: Contact) => void;
  defaults?: ContactFormDefaults;
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
  const [moreOpen, setMoreOpen] = React.useState(false);
  // Read through a ref so an inline `defaults={{…}}` prop does not reset the form on every render.
  const presetRef = React.useRef(preset);
  presetRef.current = preset;

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: defaults(null, active?.membership_id, preset) });

  const load = React.useCallback(
    (record: Contact | null) => {
      form.reset(defaults(record, active?.membership_id, presetRef.current));
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
      load(contact);
    }
  }, [open, contact, load]);

  const companies = useQuery({
    queryKey: ["crm", "companies", "picker"],
    queryFn: () => listCompanies({ sort: "name" }),
    enabled: open,
    staleTime: 60_000,
  });
  const presetCompany = preset?.company ?? null;
  const companyOptions = React.useMemo<NamedRef[]>(() => {
    const options = companies.data?.results.map((c) => ({ id: c.id, name: c.name })) ?? [];
    for (const extra of [existing?.company, presetCompany]) {
      if (extra && !options.some((o) => o.id === extra.id)) options.unshift(extra);
    }
    return options;
  }, [companies.data, existing?.company, presetCompany]);

  // Duplicate hints: always on create; on edit only once an identifying field differs from the saved record.
  const [firstName, lastName, email, phone] = useWatch({ control: form.control, name: ["first_name", "last_name", "email", "phone"] });
  const identityChanged =
    !existing ||
    firstName !== existing.first_name ||
    lastName !== existing.last_name ||
    email !== existing.email ||
    phone !== existing.phone;

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
        const errors = err.fieldErrors();
        setFieldErrors(errors);
        // Surface errors that live inside the collapsed section.
        if (Object.keys(errors).some((k) => !["first_name", "last_name", "email", "phone", "company_id", "lifecycle_stage"].includes(k))) setMoreOpen(true);
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
              {(field) => <Input {...field} autoComplete="off" autoFocus maxLength={80} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
            </FormField>
            <FormField control={form.control} name="last_name" label="Last name" serverError={fieldErrors.last_name}>
              {(field) => <Input {...field} autoComplete="off" maxLength={80} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
            </FormField>
            <FormField control={form.control} name="email" label="Email" serverError={fieldErrors.email}>
              {(field) => <Input {...field} autoComplete="off" type="email" maxLength={254} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
            </FormField>
            <FormField control={form.control} name="phone" label="Phone" serverError={fieldErrors.phone}>
              {(field) => <Input {...field} autoComplete="off" type="tel" maxLength={32} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
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
            <FormField control={form.control} name="lifecycle_stage" label="Status" serverError={fieldErrors.lifecycle_stage}>
              {(field) => (
                <LifecycleSelect id={field.id} value={field.value} onChange={(v) => field.onChange(v || "lead")} ariaInvalid={field.invalid} ariaDescribedBy={field["aria-describedby"]} />
              )}
            </FormField>
            <ContactDuplicateCheck
              className="sm:col-span-2"
              firstName={firstName ?? ""}
              lastName={lastName ?? ""}
              email={email ?? ""}
              phone={phone ?? ""}
              exclude={existing?.id}
              enabled={open && identityChanged}
            />
          </div>

          <Disclosure title="More details" summary="Job title, source, owner, address, WhatsApp consent…" open={moreOpen} onOpenChange={setMoreOpen}>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField control={form.control} name="job_title" label="Job title" serverError={fieldErrors.job_title}>
                {(field) => <Input {...field} maxLength={120} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
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
              <FormField
                control={form.control}
                name="whatsapp_opt_in"
                className="sm:col-span-2"
                description="Template messages can only be sent to contacts who agreed to receive WhatsApp messages."
                serverError={fieldErrors.whatsapp_opt_in}
              >
                {(field) => (
                  <div className="flex items-center gap-3">
                    <Switch id={field.id} checked={field.value} onCheckedChange={field.onChange} aria-describedby={field["aria-describedby"]} />
                    <Label htmlFor={field.id} className="font-normal">
                      Contact agreed to receive WhatsApp messages
                    </Label>
                  </div>
                )}
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
              {existing ? "Save changes" : "Create contact"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
