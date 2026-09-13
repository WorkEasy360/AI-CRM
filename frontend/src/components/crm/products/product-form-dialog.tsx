"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
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
import { createProduct, getProduct, updateProduct } from "@/lib/api/crm";
import type { CustomData, Product, ProductInput } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { canReassign } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";

const DECIMAL = /^\d{1,16}(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

const schema = z.object({
  name: z.string().trim().min(1, "Product name is required.").max(160, "Name is too long."),
  sku: z.string().trim().max(64, "SKU is too long."),
  unit_price: z
    .string()
    .trim()
    .refine((v) => v === "" || DECIMAL.test(v), "Enter a price with up to two decimals."),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => v === "" || CURRENCY.test(v), "Use a 3-letter currency code, e.g. USD."),
  tax_rate: z
    .string()
    .trim()
    .refine((v) => v === "" || (/^\d{1,3}(\.\d{1,2})?$/.test(v) && Number(v) <= 100), "Tax rate must be between 0 and 100."),
  tax_label: z.string().trim().max(40, "Tax label is too long."),
  status: z.enum(["active", "inactive"]),
  description: z.string().max(5000, "Description is too long."),
  owner_id: z.string(),
});
type FormValues = z.infer<typeof schema>;

function defaults(product: Product | null, membershipId: string | undefined, baseCurrency: string | undefined): FormValues {
  return {
    name: product?.name ?? "",
    sku: product?.sku ?? "",
    unit_price: product?.unit_price ?? "",
    currency: product?.currency ?? baseCurrency ?? "",
    tax_rate: product?.tax_rate ?? "",
    tax_label: product?.tax_label ?? "",
    status: product?.status ?? "active",
    description: product?.description ?? "",
    owner_id: product?.owner?.id ?? membershipId ?? "",
  };
}

function toPayload(values: FormValues, customData: CustomData, includeOwner: boolean, editing: boolean): ProductInput {
  const payload: ProductInput = {
    name: values.name,
    sku: values.sku,
    tax_label: values.tax_label,
    status: values.status,
    description: values.description,
    custom_data: customData,
  };
  // Numbers: omit when empty on create (the API defaults them to 0); send "0" on edit so clearing really clears.
  if (values.unit_price) payload.unit_price = values.unit_price;
  else if (editing) payload.unit_price = "0";
  if (values.tax_rate) payload.tax_rate = values.tax_rate;
  else if (editing) payload.tax_rate = "0";
  // Currency: omit when empty so the API falls back to the organisation base currency.
  if (values.currency) payload.currency = values.currency;
  if (includeOwner && values.owner_id) payload.owner_id = values.owner_id;
  return payload;
}

/** Create/edit dialog for a product. Pass `product` to edit; the current `version` is sent on save. */
export function ProductFormDialog({
  open,
  onOpenChange,
  product = null,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product?: Product | null;
  onSaved?: (saved: Product) => void;
}) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const baseCurrency = active?.organization.base_currency;
  const reassign = canReassign(active, "products");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const invalidate = useInvalidateRecord("product");
  const { definitions } = useCustomFields("product");

  const [fresh, setFresh] = React.useState<Product | null>(null);
  const existing = fresh ?? product;
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [customData, setCustomData] = React.useState<CustomData>({});
  const [conflict, setConflict] = React.useState(false);
  const [reloading, setReloading] = React.useState(false);

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: defaults(null, active?.membership_id, baseCurrency) });

  const load = React.useCallback(
    (record: Product | null) => {
      form.reset(defaults(record, active?.membership_id, baseCurrency));
      setCustomData(record?.custom_data ?? {});
      setFieldErrors({});
      setConflict(false);
    },
    [form, active?.membership_id, baseCurrency],
  );

  React.useEffect(() => {
    if (open) {
      setFresh(null);
      load(product);
    }
  }, [open, product, load]);

  const mutation = useMutation({
    mutationFn: (values: FormValues) => {
      const payload = toPayload(values, customData, reassign, existing !== null);
      return existing ? updateProduct(existing.id, existing.version, payload) : createProduct(payload);
    },
    onSuccess: async (saved) => {
      await invalidate(saved.id);
      toast({ tone: "success", title: existing ? "Product updated" : "Product created", description: saved.name });
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
      if (isApiError(err) && err.status === 409) {
        // e.g. sku_taken
        setFieldErrors({ sku: errorMessage(err) });
        return;
      }
      toast({ tone: "error", title: "Could not save product", description: errorMessage(err) });
    },
  });

  const reload = async () => {
    if (!existing) return;
    setReloading(true);
    try {
      const latest = await queryClient.fetchQuery({
        queryKey: crmKeys.record("products", existing.id),
        queryFn: () => getProduct(existing.id),
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
            <DialogTitle>{existing ? "Edit product" : "New product"}</DialogTitle>
            <DialogDescription>{existing ? "Update this catalogue item." : "Add an item you sell. Prices are per unit before tax."}</DialogDescription>
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
              {(field) => <Input {...field} autoFocus autoComplete="off" maxLength={160} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
            </FormField>
            <FormField control={form.control} name="sku" label="SKU" description="Must be unique within your organisation." serverError={fieldErrors.sku}>
              {(field) => <Input {...field} autoComplete="off" maxLength={64} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
            </FormField>
            <FormField control={form.control} name="status" label="Status" serverError={fieldErrors.status}>
              {(field) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id={field.id} aria-invalid={field["aria-invalid"]} aria-describedby={field["aria-describedby"]}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <FormField control={form.control} name="unit_price" label="Unit price" serverError={fieldErrors.unit_price}>
              {(field) => (
                <Input {...field} inputMode="decimal" placeholder="0.00" maxLength={20} value={field.value} onChange={(e) => field.onChange(e.target.value)} />
              )}
            </FormField>
            <FormField control={form.control} name="currency" label="Currency" serverError={fieldErrors.currency}>
              {(field) => (
                <Input
                  {...field}
                  placeholder={baseCurrency ?? "USD"}
                  maxLength={3}
                  className="uppercase"
                  autoCapitalize="characters"
                  value={field.value}
                  onChange={(e) => field.onChange(e.target.value)}
                />
              )}
            </FormField>
            <FormField control={form.control} name="tax_rate" label="Tax rate (%)" serverError={fieldErrors.tax_rate}>
              {(field) => (
                <Input {...field} inputMode="decimal" placeholder="0" maxLength={6} value={field.value} onChange={(e) => field.onChange(e.target.value)} />
              )}
            </FormField>
            <FormField control={form.control} name="tax_label" label="Tax label" description="Shown next to the rate, e.g. VAT or GST." serverError={fieldErrors.tax_label}>
              {(field) => <Input {...field} maxLength={40} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
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

          <CustomFieldsForm definitions={definitions} value={customData} onChange={setCustomData} errors={fieldErrors} disabled={mutation.isPending} />

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {existing ? "Save changes" : "Create product"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
