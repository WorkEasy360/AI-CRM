"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Trash2 } from "lucide-react";
import { z } from "zod";
import { RecordPicker } from "@/components/activities/pickers";
import { CustomFieldsForm, useCustomFields } from "@/components/crm/custom-fields-form";
import { InlineContactForm } from "@/components/crm/deals/inline-contact-form";
import { OwnerSelect } from "@/components/crm/owner-select";
import { isVersionConflict, useArchiveRestore, useInvalidateRecord } from "@/components/crm/use-record-mutations";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { createCompany, createDeal, updateDeal } from "@/lib/api/crm";
import type { CustomData, Deal, DealInput, NamedRef, Pipeline } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { can, canReassign } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";

const DECIMAL = /^\d{1,16}(\.\d{1,2})?$/;
const RATE = /^\d{1,10}(\.\d{1,8})?$/;

const recordRef = z.object({ id: z.string(), name: z.string() }).nullable();

const dealSchema = z.object({
  name: z.string().trim().min(1, "Deal name is required.").max(160, "Deal name is too long."),
  pipeline_id: z.string(),
  company: recordRef,
  primary_contact: recordRef,
  amount: z.string().trim().refine((v) => v === "" || DECIMAL.test(v), "Enter an amount like 1500 or 1500.50."),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Use a 3-letter currency code."),
  exchange_rate: z.string().trim().refine((v) => v === "" || (RATE.test(v) && Number(v) > 0), "Enter a positive rate (up to 8 decimals)."),
  expected_close_date: z.string().trim().refine((v) => v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v), "Use the YYYY-MM-DD format."),
  description: z.string().max(5000, "Description is too long."),
  owner_id: z.string(),
});
type DealFormValues = z.infer<typeof dealSchema>;

/** Records to preselect on create (e.g. `/pipeline?new=1&company=<id>&contact=<id>` from a record page). */
export interface DealFormDefaults {
  company?: NamedRef | null;
  contact?: { id: string; name: string } | null;
}

function defaultsFor(
  deal: Deal | null,
  pipelines: Pipeline[],
  defaultPipelineId: string | undefined,
  baseCurrency: string,
  defaults: DealFormDefaults | undefined,
  selfMembershipId: string,
): DealFormValues {
  const pipeline = pipelines.find((p) => p.id === defaultPipelineId) ?? pipelines.find((p) => p.is_default) ?? pipelines[0];
  const contact = deal ? deal.primary_contact : (defaults?.contact ?? null);
  return {
    name: deal?.name ?? "",
    pipeline_id: deal?.pipeline.id ?? pipeline?.id ?? "",
    company: deal ? (deal.company ?? null) : (defaults?.company ?? null),
    primary_contact: contact ? { id: contact.id, name: contact.name } : null,
    amount: deal?.amount ?? "",
    currency: deal?.currency ?? baseCurrency,
    exchange_rate: deal ? (deal.currency === baseCurrency ? "" : deal.exchange_rate) : "",
    expected_close_date: deal?.expected_close_date ?? "",
    description: deal?.description ?? "",
    owner_id: deal?.owner?.id ?? selfMembershipId,
  };
}

/** Section heading inside the panel body. */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-md font-semibold text-fg">{children}</h3>;
}

/**
 * Create or edit a deal in a right-hand slide-over. Every field is typed by the user: company and
 * primary contact are search-as-you-type pickers that can also create what they did not find, so a
 * company or person named here becomes a real record in Companies/Contacts rather than a label that
 * exists only on the deal.
 *
 * Stage and probability are deliberately absent: a new deal starts in the pipeline's first open stage
 * and follows that stage's probability, and both change afterwards through the stage move flow, which
 * is what records stage history.
 */
export function DealFormDialog({
  open,
  onOpenChange,
  deal,
  pipelines,
  defaultPipelineId,
  defaults,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing deal to edit; omit (or null) to create. */
  deal?: Deal | null;
  pipelines: Pipeline[];
  defaultPipelineId?: string;
  defaults?: DealFormDefaults;
  onSaved?: (deal: Deal) => void;
  onDeleted?: (id: string) => void;
}) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const baseCurrency = active?.organization.base_currency ?? "USD";
  const allowReassign = canReassign(active, "deals");
  const selfMembershipId = active?.membership_id ?? "";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateRecord("deal");
  const { archive } = useArchiveRestore("deal");
  const { definitions } = useCustomFields("deal");
  const [customData, setCustomData] = React.useState<CustomData>({});
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  /** Non-null while the inline "new contact" form is open; holds the text typed into the picker. */
  const [contactDraft, setContactDraft] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const existing = deal ?? null;
  const isNew = existing === null;
  const ownerId = React.useId();
  const canDelete = !isNew && can(active, "deals.delete") && !existing.archived_at;

  const form = useForm<DealFormValues>({
    resolver: zodResolver(dealSchema),
    defaultValues: defaultsFor(existing, pipelines, defaultPipelineId, baseCurrency, defaults, selfMembershipId),
  });

  React.useEffect(() => {
    if (open) {
      form.reset(defaultsFor(existing, pipelines, defaultPipelineId, baseCurrency, defaults, selfMembershipId));
      setCustomData(existing?.custom_data ?? {});
      setFieldErrors({});
      setContactDraft(null);
      setConfirmDelete(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing, pipelines, defaultPipelineId, baseCurrency, defaults, selfMembershipId]);

  const company = form.watch("company");
  const currency = form.watch("currency");
  const foreignCurrency = Boolean(currency) && currency.toUpperCase() !== baseCurrency;

  // "Create company X" from the picker: the company is saved first, then linked to this deal.
  const companyCreate = useMutation({
    mutationFn: (name: string) => createCompany({ name }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ["crm", "companies"] });
      form.setValue("company", { id: created.id, name: created.name }, { shouldDirty: true });
      toast({ tone: "success", title: "Company created", description: created.name });
    },
    onError: (err) => toast({ tone: "error", title: "Could not create company", description: errorMessage(err) }),
  });

  const mutation = useMutation({
    mutationFn: (values: DealFormValues) => {
      const input: DealInput = {
        name: values.name,
        company_id: values.company?.id ?? null,
        primary_contact_id: values.primary_contact?.id ?? null,
        amount: values.amount || "0",
        currency: values.currency,
        expected_close_date: values.expected_close_date || null,
        description: values.description,
        custom_data: customData,
      };
      if (values.currency !== baseCurrency) input.exchange_rate = values.exchange_rate || "1";
      if (allowReassign && values.owner_id) input.owner_id = values.owner_id;
      if (isNew) {
        if (values.pipeline_id) input.pipeline_id = values.pipeline_id;
        return createDeal(input);
      }
      return updateDeal(existing.id, existing.version, input);
    },
    onSuccess: async (saved) => {
      await invalidate(saved.id);
      toast({ tone: "success", title: isNew ? "Deal created" : "Deal updated", description: saved.name });
      onSaved?.(saved);
      onOpenChange(false);
    },
    onError: (err) => {
      if (isVersionConflict(err)) {
        setFieldErrors({ non_field_errors: "Someone else changed this deal since you opened it. Close this panel and reload to see the latest version." });
      } else if (isApiError(err) && err.isValidation) {
        setFieldErrors(err.fieldErrors());
      } else {
        toast({ tone: "error", title: "Could not save deal", description: errorMessage(err) });
      }
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    setFieldErrors({});
    mutation.mutate(values);
  });

  const onDelete = () => {
    if (isNew) return;
    archive.mutate(existing.id, {
      onSuccess: () => {
        setConfirmDelete(false);
        onDeleted?.(existing.id);
        onOpenChange(false);
      },
    });
  };

  const customErrors = React.useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(fieldErrors)) if (k.startsWith("custom_data")) out[k] = v;
    return out;
  }, [fieldErrors]);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-[min(46rem,100%)] p-0">
          <form onSubmit={onSubmit} className="flex h-full min-h-0 flex-col" noValidate>
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-6 py-4 pr-12">
              <div className="flex flex-col gap-1">
                <SheetTitle className="text-lg font-semibold leading-tight text-fg">{isNew ? "Create Deal" : "Edit Deal"}</SheetTitle>
                <SheetDescription className="text-sm text-fg-muted">
                  {isNew ? "Add a deal to the pipeline." : "Update the deal details. Move stages from the board or the deal page."}
                </SheetDescription>
              </div>
              {allowReassign ? (
                <div className="flex items-center gap-2">
                  <Label htmlFor={ownerId}>Owner</Label>
                  <div className="flex w-52 flex-col gap-1">
                    <OwnerSelect id={ownerId} value={form.watch("owner_id")} onChange={(v) => form.setValue("owner_id", v)} ariaInvalid={Boolean(fieldErrors.owner_id)} />
                    {fieldErrors.owner_id ? (
                      <p role="alert" className="text-xs text-danger">
                        {fieldErrors.owner_id}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
              <FormError message={fieldErrors.non_field_errors ?? fieldErrors.detail} />

              <SectionTitle>Deal Information</SectionTitle>

              <div className="grid gap-4">
                <FormField control={form.control} name="name" label="Deal name" orientation="horizontal" required serverError={fieldErrors.name}>
                  {(field) => <Input {...field} autoFocus maxLength={160} placeholder="Acme renewal" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
                </FormField>

                <FormField
                  control={form.control}
                  name="company"
                  label="Company"
                  orientation="horizontal"
                  serverError={fieldErrors.company_id}
                  description="Type to search, or add one that does not exist yet."
                >
                  {(field) => (
                    <RecordPicker
                      id={field.id}
                      entity="company"
                      value={field.value}
                      onChange={field.onChange}
                      className="h-9"
                      placeholder="Search companies…"
                      ariaInvalid={field.invalid}
                      ariaDescribedBy={field["aria-describedby"]}
                      onCreate={(name) => companyCreate.mutate(name)}
                      createLabel="Create company"
                      creating={companyCreate.isPending}
                    />
                  )}
                </FormField>

                <FormField
                  control={form.control}
                  name="primary_contact"
                  label="Primary contact"
                  orientation="horizontal"
                  serverError={fieldErrors.primary_contact_id}
                  description="Type to search, or add a new person — they are saved to Contacts."
                >
                  {(field) => (
                    <RecordPicker
                      id={field.id}
                      entity="contact"
                      value={field.value}
                      onChange={(next) => {
                        field.onChange(next);
                        setContactDraft(null);
                      }}
                      className="h-9"
                      placeholder="Search contacts…"
                      ariaInvalid={field.invalid}
                      ariaDescribedBy={field["aria-describedby"]}
                      onCreate={(name) => setContactDraft(name)}
                      createLabel="Create contact"
                    />
                  )}
                </FormField>

                {/* Sits below the field rather than inside it, so the field's hint stays next to the picker. */}
                {contactDraft !== null ? (
                  <div className="sm:pl-[calc(10rem+1rem)]">
                    <InlineContactForm
                      initialName={contactDraft}
                      companyId={company?.id ?? null}
                      onCancel={() => setContactDraft(null)}
                      onCreated={(contact) => {
                        form.setValue("primary_contact", contact, { shouldDirty: true });
                        setContactDraft(null);
                        toast({ tone: "success", title: "Contact created", description: contact.name });
                      }}
                    />
                  </div>
                ) : null}

                <FormField control={form.control} name="amount" label="Amount" orientation="horizontal" serverError={fieldErrors.amount}>
                  {(field) => <Input {...field} inputMode="decimal" placeholder="0.00" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
                </FormField>

                <FormField control={form.control} name="currency" label="Currency" orientation="horizontal" required serverError={fieldErrors.currency}>
                  {(field) => <Input {...field} maxLength={3} placeholder={baseCurrency} className="w-28 uppercase" value={field.value} onChange={(e) => field.onChange(e.target.value.toUpperCase())} />}
                </FormField>

                {foreignCurrency ? (
                  <FormField
                    control={form.control}
                    name="exchange_rate"
                    label={`Rate to ${baseCurrency}`}
                    orientation="horizontal"
                    serverError={fieldErrors.exchange_rate}
                    description={`How many ${baseCurrency} one ${currency.toUpperCase()} is worth. Blank uses 1.`}
                  >
                    {(field) => <Input {...field} inputMode="decimal" placeholder="1" className="w-40" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
                  </FormField>
                ) : null}

                <FormField control={form.control} name="expected_close_date" label="Expected close" orientation="horizontal" serverError={fieldErrors.expected_close_date}>
                  {(field) => <Input {...field} type="date" className="w-48" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
                </FormField>

                <FormField control={form.control} name="description" label="Description" orientation="horizontal" serverError={fieldErrors.description}>
                  {(field) => <Textarea {...field} rows={3} maxLength={5000} placeholder="A few words about this deal" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
                </FormField>
              </div>

              {definitions.length > 0 ? (
                <div className="grid gap-4 border-t border-border pt-5">
                  <SectionTitle>Additional Information</SectionTitle>
                  <CustomFieldsForm definitions={definitions} value={customData} onChange={setCustomData} errors={customErrors} disabled={mutation.isPending} />
                </div>
              ) : null}

              <div className="grid gap-2 border-t border-border pt-5">
                <SectionTitle>Products</SectionTitle>
                <p className="text-sm text-fg-muted">
                  {isNew ? (
                    "Line items are added on the deal once it exists, so pricing is versioned against a saved deal."
                  ) : (
                    <Link href={`/deals/${existing.id}`} className="text-primary underline-offset-4 hover:underline">
                      Manage line items on the deal
                    </Link>
                  )}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-surface px-6 py-3">
              <div className="flex items-center gap-4">
                <Link href="/settings/custom-fields" className="text-sm text-primary underline-offset-4 hover:underline">
                  Customize Fields
                </Link>
                {canDelete ? (
                  <Button type="button" variant="danger-ghost" size="sm" onClick={() => setConfirmDelete(true)}>
                    <Trash2 /> Delete
                  </Button>
                ) : null}
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" loading={mutation.isPending}>
                  {isNew ? "Create deal" : "Save changes"}
                </Button>
              </div>
            </div>
          </form>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this deal?"
        description={
          <>
            <strong>{existing?.name}</strong> is removed from the pipeline and every list. It is kept as an archived record, so it
            can be restored — nothing is erased.
          </>
        }
        confirmLabel="Delete deal"
        destructive
        loading={archive.isPending}
        onConfirm={onDelete}
      />
    </>
  );
}
