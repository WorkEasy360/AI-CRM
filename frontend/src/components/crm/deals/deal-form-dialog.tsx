"use client";

import * as React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronDown, ChevronUp } from "lucide-react";
import { z } from "zod";
import { CustomFieldsForm, useCustomFields } from "@/components/crm/custom-fields-form";
import { OwnerSelect } from "@/components/crm/owner-select";
import { isVersionConflict, useInvalidateRecord } from "@/components/crm/use-record-mutations";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input, Textarea } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { createDeal, listCompanies, listContacts, updateDeal } from "@/lib/api/crm";
import type { CustomData, Deal, DealInput, NamedRef, Pipeline } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { canReassign } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";

const NONE = "__none__";
const DECIMAL = /^\d{1,16}(\.\d{1,2})?$/;
const RATE = /^\d{1,10}(\.\d{1,8})?$/;

const dealSchema = z.object({
  name: z.string().trim().min(1, "Deal name is required.").max(160, "Deal name is too long."),
  pipeline_id: z.string(),
  stage_id: z.string(),
  company_id: z.string(),
  primary_contact_id: z.string(),
  amount: z.string().trim().regex(DECIMAL, "Enter an amount like 1500 or 1500.50."),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Use a 3-letter currency code."),
  exchange_rate: z.string().trim().refine((v) => v === "" || (RATE.test(v) && Number(v) > 0), "Enter a positive rate (up to 8 decimals)."),
  probability: z
    .string()
    .trim()
    .refine((v) => v === "" || (/^\d{1,3}$/.test(v) && Number(v) <= 100), "Enter a whole number from 0 to 100."),
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

function defaultsFor(deal: Deal | null, pipelines: Pipeline[], defaultPipelineId: string | undefined, baseCurrency: string, defaults: DealFormDefaults | undefined): DealFormValues {
  const pipeline = pipelines.find((p) => p.id === defaultPipelineId) ?? pipelines.find((p) => p.is_default) ?? pipelines[0];
  return {
    name: deal?.name ?? "",
    pipeline_id: deal?.pipeline.id ?? pipeline?.id ?? "",
    stage_id: deal?.stage.id ?? "",
    company_id: deal ? (deal.company?.id ?? NONE) : (defaults?.company?.id ?? NONE),
    primary_contact_id: deal ? (deal.primary_contact?.id ?? NONE) : (defaults?.contact?.id ?? NONE),
    amount: deal?.amount ?? "0",
    currency: deal?.currency ?? baseCurrency,
    exchange_rate: deal ? (deal.currency === baseCurrency ? "" : deal.exchange_rate) : "",
    // Only a hand-set probability is shown as a value; otherwise the stage default applies.
    probability: deal?.probability_overridden ? String(deal.probability) : "",
    expected_close_date: deal?.expected_close_date ?? "",
    description: deal?.description ?? "",
    owner_id: deal?.owner?.id ?? "",
  };
}

/**
 * Create or edit a deal. The basics (name, who, how much, when, stage) sit up front; probability
 * override, exchange rate, owner, description and custom fields live under "More details".
 * Pipeline and stage are chosen on create only (the API rejects them on update; use the stage move flow).
 */
export function DealFormDialog({
  open,
  onOpenChange,
  deal,
  pipelines,
  defaultPipelineId,
  defaults,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing deal to edit; omit (or null) to create. */
  deal?: Deal | null;
  pipelines: Pipeline[];
  defaultPipelineId?: string;
  defaults?: DealFormDefaults;
  onSaved?: (deal: Deal) => void;
}) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const baseCurrency = active?.organization.base_currency ?? "USD";
  const allowReassign = canReassign(active, "deals");
  const { toast } = useToast();
  const invalidate = useInvalidateRecord("deal");
  const { definitions } = useCustomFields("deal");
  const [customData, setCustomData] = React.useState<CustomData>({});
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const existing = deal ?? null;
  const isNew = existing === null;
  const [moreOpen, setMoreOpen] = React.useState(!isNew);
  const moreId = React.useId();

  const form = useForm<DealFormValues>({
    resolver: zodResolver(dealSchema),
    defaultValues: defaultsFor(existing, pipelines, defaultPipelineId, baseCurrency, defaults),
  });

  React.useEffect(() => {
    if (open) {
      form.reset(defaultsFor(existing, pipelines, defaultPipelineId, baseCurrency, defaults));
      setCustomData(existing?.custom_data ?? {});
      setFieldErrors({});
      setMoreOpen(!isNew);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing, pipelines, defaultPipelineId, baseCurrency, defaults]);

  const pipelineId = form.watch("pipeline_id");
  const stageId = form.watch("stage_id");
  const companyId = form.watch("company_id");
  const currency = form.watch("currency");
  const stages = React.useMemo(() => (pipelines.find((p) => p.id === pipelineId)?.stages ?? []).filter((s) => !s.archived_at), [pipelines, pipelineId]);
  const selectedStage = React.useMemo(() => {
    if (!isNew) return pipelines.flatMap((p) => p.stages).find((s) => s.id === existing.stage.id) ?? null;
    return stages.find((s) => s.id === stageId) ?? stages.find((s) => s.kind === "open") ?? null;
  }, [isNew, existing, pipelines, stages, stageId]);

  const foreignCurrency = Boolean(currency) && currency.toUpperCase() !== baseCurrency;
  // The exchange rate matters as soon as the currency differs from the base one: surface the section.
  React.useEffect(() => {
    if (foreignCurrency) setMoreOpen(true);
  }, [foreignCurrency]);

  const companies = useQuery({
    queryKey: crmKeys.list("companies", { sort: "name", picker: "deal" }),
    queryFn: () => listCompanies({ sort: "name" }),
    enabled: open,
    staleTime: 60_000,
  });
  const contactParams = React.useMemo(() => ({ sort: "name", ...(companyId && companyId !== NONE ? { company: companyId } : {}) }), [companyId]);
  const contacts = useQuery({
    queryKey: crmKeys.list("contacts", { ...contactParams, picker: "deal" }),
    queryFn: () => listContacts(contactParams),
    enabled: open,
    staleTime: 60_000,
  });

  const mutation = useMutation({
    mutationFn: (values: DealFormValues) => {
      const input: DealInput = {
        name: values.name,
        company_id: values.company_id === NONE ? null : values.company_id,
        primary_contact_id: values.primary_contact_id === NONE ? null : values.primary_contact_id,
        amount: values.amount,
        currency: values.currency,
        expected_close_date: values.expected_close_date || null,
        description: values.description,
        custom_data: customData,
      };
      if (values.currency !== baseCurrency) input.exchange_rate = values.exchange_rate || "1";
      if (values.probability !== "" && (isNew || existing?.status === "open")) input.probability = Number(values.probability);
      if (allowReassign && values.owner_id) input.owner_id = values.owner_id;
      if (isNew) {
        if (values.pipeline_id) input.pipeline_id = values.pipeline_id;
        if (values.stage_id) input.stage_id = values.stage_id;
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
        setFieldErrors({ non_field_errors: "Someone else changed this deal since you opened it. Close this dialog and reload to see the latest version." });
      } else if (isApiError(err) && err.isValidation) {
        setFieldErrors(err.fieldErrors());
        setMoreOpen(true);
      } else {
        toast({ tone: "error", title: "Could not save deal", description: errorMessage(err) });
      }
    },
  });

  const onSubmit = form.handleSubmit(
    (values) => {
      setFieldErrors({});
      mutation.mutate(values);
    },
    () => setMoreOpen(true),
  );

  const customErrors = React.useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(fieldErrors)) if (k.startsWith("custom_data")) out[k] = v;
    return out;
  }, [fieldErrors]);

  const companyOptions = companies.data?.results ?? [];
  const contactOptions = contacts.data?.results ?? [];
  const presetCompany = existing?.company ?? (isNew ? defaults?.company : null) ?? null;
  const presetContact = existing?.primary_contact ?? (isNew ? defaults?.contact : null) ?? null;
  const probabilityLocked = !isNew && existing?.status !== "open";
  const stageDefault = selectedStage?.default_probability;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-y-auto">
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{isNew ? "New deal" : "Edit deal"}</DialogTitle>
            <DialogDescription>{isNew ? "Add a deal to the pipeline." : "Update the deal details. Move stages from the board or the deal page."}</DialogDescription>
          </DialogHeader>
          <FormError message={fieldErrors.non_field_errors ?? fieldErrors.detail} />

          <FormField control={form.control} name="name" label="Deal name" serverError={fieldErrors.name}>
            {(field) => <Input {...field} autoFocus maxLength={160} placeholder="Acme renewal" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField control={form.control} name="company_id" label="Company" serverError={fieldErrors.company_id}>
              {(field) => (
                <Select
                  value={field.value}
                  onValueChange={(v) => {
                    field.onChange(v);
                    form.setValue("primary_contact_id", NONE);
                  }}
                >
                  <SelectTrigger id={field.id} aria-invalid={field["aria-invalid"]} aria-describedby={field["aria-describedby"]}>
                    <SelectValue placeholder={companies.isPending ? "Loading…" : "No company"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No company</SelectItem>
                    {presetCompany && !companyOptions.some((c) => c.id === presetCompany.id) ? <SelectItem value={presetCompany.id}>{presetCompany.name || "Selected company"}</SelectItem> : null}
                    {companyOptions.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <FormField control={form.control} name="primary_contact_id" label="Primary contact" serverError={fieldErrors.primary_contact_id}>
              {(field) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id={field.id} aria-invalid={field["aria-invalid"]} aria-describedby={field["aria-describedby"]}>
                    <SelectValue placeholder={contacts.isPending ? "Loading…" : "No contact"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No contact</SelectItem>
                    {presetContact && !contactOptions.some((c) => c.id === presetContact.id) ? <SelectItem value={presetContact.id}>{presetContact.name || "Selected contact"}</SelectItem> : null}
                    {contactOptions.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <FormField control={form.control} name="amount" label="Amount" serverError={fieldErrors.amount}>
              {(field) => <Input {...field} inputMode="decimal" placeholder="0.00" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
            </FormField>
            <FormField control={form.control} name="currency" label="Currency" serverError={fieldErrors.currency}>
              {(field) => <Input {...field} maxLength={3} placeholder={baseCurrency} className="uppercase" value={field.value} onChange={(e) => field.onChange(e.target.value.toUpperCase())} />}
            </FormField>
            <FormField control={form.control} name="expected_close_date" label="Expected close" serverError={fieldErrors.expected_close_date}>
              {(field) => <Input {...field} type="date" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
            </FormField>
          </div>

          {isNew ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {pipelines.length > 1 ? (
                <FormField control={form.control} name="pipeline_id" label="Pipeline" serverError={fieldErrors.pipeline_id}>
                  {(field) => (
                    <Select
                      value={field.value}
                      onValueChange={(v) => {
                        field.onChange(v);
                        form.setValue("stage_id", "");
                      }}
                    >
                      <SelectTrigger id={field.id} aria-invalid={field["aria-invalid"]} aria-describedby={field["aria-describedby"]}>
                        <SelectValue placeholder="Choose a pipeline" />
                      </SelectTrigger>
                      <SelectContent>
                        {pipelines.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </FormField>
              ) : null}
              <FormField control={form.control} name="stage_id" label="Stage" serverError={fieldErrors.stage_id} description="Defaults to the first open stage.">
                {(field) => (
                  <Select value={field.value || NONE} onValueChange={(v) => field.onChange(v === NONE ? "" : v)}>
                    <SelectTrigger id={field.id} aria-invalid={field["aria-invalid"]} aria-describedby={field["aria-describedby"]}>
                      <SelectValue placeholder="First open stage" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>First open stage</SelectItem>
                      {stages.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
            </div>
          ) : null}

          <div className="border-t border-border pt-3">
            <button
              type="button"
              className="inline-flex items-center gap-1 text-sm font-medium text-fg-muted hover:text-fg"
              aria-expanded={moreOpen}
              aria-controls={moreId}
              onClick={() => setMoreOpen((v) => !v)}
            >
              {moreOpen ? <ChevronUp className="size-4" aria-hidden /> : <ChevronDown className="size-4" aria-hidden />}
              More details
            </button>
          </div>

          {moreOpen ? (
            <div id={moreId} className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="probability"
                  label="Probability (%)"
                  serverError={fieldErrors.probability}
                  description={probabilityLocked ? "Fixed for closed deals." : stageDefault !== undefined ? `Stage default is ${stageDefault}%. Leave blank to follow the stage.` : "Leave blank to follow the stage default."}
                >
                  {(field) => (
                    <Input
                      {...field}
                      inputMode="numeric"
                      placeholder={stageDefault !== undefined ? String(stageDefault) : "Stage default"}
                      value={field.value}
                      onChange={(e) => field.onChange(e.target.value)}
                      disabled={probabilityLocked}
                    />
                  )}
                </FormField>
                {foreignCurrency ? (
                  <FormField control={form.control} name="exchange_rate" label={`Rate to ${baseCurrency}`} serverError={fieldErrors.exchange_rate} description={`How many ${baseCurrency} one ${currency.toUpperCase()} is worth.`}>
                    {(field) => <Input {...field} inputMode="decimal" placeholder="1" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
                  </FormField>
                ) : null}
                {allowReassign ? (
                  <FormField control={form.control} name="owner_id" label="Owner" serverError={fieldErrors.owner_id}>
                    {(field) => <OwnerSelect id={field.id} value={field.value} onChange={field.onChange} ariaInvalid={field.invalid} />}
                  </FormField>
                ) : null}
              </div>

              <FormField control={form.control} name="description" label="Description" serverError={fieldErrors.description}>
                {(field) => <Textarea {...field} rows={3} maxLength={5000} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
              </FormField>

              <CustomFieldsForm definitions={definitions} value={customData} onChange={setCustomData} errors={customErrors} disabled={mutation.isPending} />
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {isNew ? "Create deal" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
