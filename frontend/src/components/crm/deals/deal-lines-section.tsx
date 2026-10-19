"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Package, Pencil, Plus, Trash2 } from "lucide-react";
import { z } from "zod";
import "@/lib/zod-config";
import { Section } from "@/components/crm/record-page";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { addDealLine, dealLines, listPriceBooks, listProducts, removeDealLine, updateDeal, updateDealLine } from "@/lib/api/crm";
import type { Deal, DealLine, DealLineInput } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { formatMoney, formatNumber } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";

const DEC2 = /^\d{1,16}(\.\d{1,2})?$/;
const DEC3 = /^\d{1,9}(\.\d{1,3})?$/;
const PCT = /^\d{1,3}(\.\d{1,2})?$/;

const lineSchema = z.object({
  product_id: z.string().min(1, "Choose a product."),
  quantity: z.string().trim().refine((v) => DEC3.test(v) && Number(v) > 0, "Enter a positive quantity (up to 3 decimals)."),
  unit_price: z.string().trim().refine((v) => v === "" || DEC2.test(v), "Enter a price like 99 or 99.50."),
  discount_percent: z.string().trim().refine((v) => v === "" || (PCT.test(v) && Number(v) <= 100), "Enter a discount from 0 to 100."),
  tax_rate: z.string().trim().refine((v) => v === "" || (PCT.test(v) && Number(v) <= 100), "Enter a tax rate from 0 to 100."),
});
type LineFormValues = z.infer<typeof lineSchema>;

/** Product lines of a deal (the quote) with add / edit / remove. */
export function DealLinesSection({ deal, editable }: { deal: Deal; editable: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const lines = useQuery({ queryKey: crmKeys.dealLines(deal.id), queryFn: () => dealLines(deal.id) });
  const [editing, setEditing] = React.useState<DealLine | "new" | null>(null);
  const [removing, setRemoving] = React.useState<DealLine | null>(null);

  // A line change recomputes the deal amount and bumps its version: refresh the deal and every deal view.
  const refresh = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: crmKeys.dealLines(deal.id) }), queryClient.invalidateQueries({ queryKey: ["crm", "deals"] })]);
  const books = useQuery({ queryKey: crmKeys.priceBooks, queryFn: listPriceBooks, enabled: editable, staleTime: 60_000 });
  const usableBooks = (books.data?.results ?? []).filter((b) => b.is_active && b.currency === deal.currency);
  const setBook = useMutation({
    mutationFn: (id: string | null) => updateDeal(deal.id, deal.version, { price_book_id: id }),
    onSuccess: refresh,
    onError: (err) => toast({ tone: "error", title: "Could not change the price book", description: errorMessage(err) }),
  });

  const remove = useMutation({
    mutationFn: (line: DealLine) => removeDealLine(deal.id, line.id),
    onSuccess: async () => {
      await refresh();
      setRemoving(null);
    },
    onError: (err) => toast({ tone: "error", title: "Could not remove product", description: errorMessage(err) }),
  });

  const items = lines.data?.results ?? [];
  // Money columns are absent when the member's field rules hide them.
  const showMoney = items.every((l) => l.line_total !== undefined);
  const sum = (key: "subtotal" | "tax_amount" | "line_total") => items.reduce((acc, l) => acc + Number(l[key] || 0), 0);

  return (
    <Section
      title="Products"
      actions={
        editable ? (
          <div className="flex items-center gap-2">
            {usableBooks.length || deal.price_book ? (
              <Select value={deal.price_book?.id ?? "none"} onValueChange={(v) => setBook.mutate(v === "none" ? null : v)}>
                <SelectTrigger className="h-8 w-44" aria-label="Price book">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">List prices</SelectItem>
                  {deal.price_book && !usableBooks.some((b) => b.id === deal.price_book?.id) ? (
                    <SelectItem value={deal.price_book.id}>{deal.price_book.name}</SelectItem>
                  ) : null}
                  {usableBooks.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
              <Plus /> Add product
            </Button>
          </div>
        ) : deal.price_book ? (
          <span className="text-xs text-fg-muted">Prices from {deal.price_book.name}</span>
        ) : undefined
      }
    >
      {deal.amount_from_lines ? (
        <p className="mb-2 text-xs text-fg-muted">The deal amount is the total of these lines, tax included; change the lines to change it.</p>
      ) : null}
      {lines.isPending ? (
        <SkeletonRows rows={3} />
      ) : lines.isError ? (
        <p className="text-sm text-danger">{errorMessage(lines.error)}</p>
      ) : items.length === 0 ? (
        <EmptyState icon={<Package />} title="No products yet" description="Add products to build the quote for this deal." className="py-8" />
      ) : (
        <Table>
          <caption className="sr-only">Deal products</caption>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Unit price</TableHead>
              <TableHead className="text-right">Discount</TableHead>
              <TableHead className="text-right">Tax</TableHead>
              {showMoney ? <TableHead className="text-right">Subtotal</TableHead> : null}
              <TableHead className="text-right">Line total</TableHead>
              {editable ? (
                <TableHead className="w-20">
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((line) => (
              <TableRow key={line.id}>
                <TableCell>
                  <div className="font-medium">{line.product.name}</div>
                  {line.sku ? <div className="text-xs text-fg-subtle">{line.sku}</div> : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">{line.quantity !== undefined ? formatNumber(line.quantity) : <Hidden />}</TableCell>
                <TableCell className="text-right tabular-nums">{line.unit_price !== undefined ? formatMoney(line.unit_price, line.currency) : <Hidden />}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {line.discount_percent === undefined ? <Hidden /> : Number(line.discount_percent) ? `${formatNumber(line.discount_percent)}%` : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {line.tax_rate === undefined ? <Hidden /> : Number(line.tax_rate) ? `${formatNumber(line.tax_rate)}%` : "—"}
                  {line.tax_amount !== undefined && Number(line.tax_amount) ? (
                    <div className="text-xs text-fg-subtle">{formatMoney(line.tax_amount, line.currency)}</div>
                  ) : null}
                </TableCell>
                {showMoney ? <TableCell className="text-right tabular-nums">{formatMoney(line.subtotal, line.currency)}</TableCell> : null}
                <TableCell className="text-right font-medium tabular-nums">{line.line_total !== undefined ? formatMoney(line.line_total, line.currency) : <Hidden />}</TableCell>
                {editable ? (
                  <TableCell>
                    <div className="flex justify-end gap-0.5">
                      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${line.product.name}`} onClick={() => setEditing(line)}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove ${line.product.name}`} onClick={() => setRemoving(line)}>
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
            {showMoney ? (
              <TableRow className="bg-surface-sunken font-semibold hover:bg-surface-sunken">
                <TableCell colSpan={4} className="text-right">
                  Total
                </TableCell>
                <TableCell className="text-right text-xs font-normal tabular-nums text-fg-muted">tax {formatMoney(sum("tax_amount"), deal.currency)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(sum("subtotal"), deal.currency)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(sum("line_total"), deal.currency)}</TableCell>
                {editable ? <TableCell /> : null}
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      )}
      <LineDialog deal={deal} line={editing} onOpenChange={(open) => !open && setEditing(null)} onSaved={refresh} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.product.name ?? "product"}?`}
        description="The line is removed from this deal; the product itself is kept."
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </Section>
  );
}

function Hidden() {
  return <span className="text-fg-subtle" title="Hidden by your field permissions">Hidden</span>;
}

function LineDialog({ deal, line, onOpenChange, onSaved }: { deal: Deal; line: DealLine | "new" | null; onOpenChange: (open: boolean) => void; onSaved: () => Promise<unknown> }) {
  const { toast } = useToast();
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const open = line !== null;
  const existing = line && line !== "new" ? line : null;
  const products = useQuery({
    queryKey: crmKeys.list("products", { status: "active", sort: "name", picker: "deal" }),
    queryFn: () => listProducts({ status: "active", sort: "name" }),
    enabled: open,
    staleTime: 60_000,
  });

  const form = useForm<LineFormValues>({
    resolver: zodResolver(lineSchema),
    defaultValues: { product_id: "", quantity: "1", unit_price: "", discount_percent: "", tax_rate: "" },
  });

  React.useEffect(() => {
    if (open) {
      form.reset({
        product_id: existing?.product.id ?? "",
        quantity: existing?.quantity ?? "1",
        unit_price: existing?.unit_price ?? "",
        discount_percent: existing?.discount_percent ?? "",
        tax_rate: existing?.tax_rate ?? "",
      });
      setFieldErrors({});
    }
  }, [open, existing, form]);

  const productId = form.watch("product_id");

  const mutation = useMutation({
    mutationFn: (values: LineFormValues) => {
      const input: DealLineInput = { quantity: values.quantity };
      if (values.unit_price !== "") input.unit_price = values.unit_price;
      if (values.discount_percent !== "") input.discount_percent = values.discount_percent;
      if (values.tax_rate !== "") input.tax_rate = values.tax_rate;
      if (existing) return updateDealLine(deal.id, existing.id, input);
      return addDealLine(deal.id, { product_id: values.product_id, ...input });
    },
    onSuccess: async () => {
      await onSaved();
      toast({ tone: "success", title: existing ? "Product updated" : "Product added" });
      onOpenChange(false);
    },
    onError: (err) => {
      if (isApiError(err) && err.isValidation) setFieldErrors(err.fieldErrors());
      else toast({ tone: "error", title: "Could not save product", description: errorMessage(err) });
    },
  });

  const options = products.data?.results ?? [];
  const selected = options.find((p) => p.id === productId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={form.handleSubmit((v) => {
            setFieldErrors({});
            mutation.mutate(v);
          })}
        >
          <DialogHeader>
            <DialogTitle>{existing ? "Edit product line" : "Add a product"}</DialogTitle>
            <DialogDescription>
              Leave the price blank to use {deal.price_book ? `the ${deal.price_book.name} price` : "the product’s list price"}. Tax is charged on the discounted price; totals are computed on save.
            </DialogDescription>
          </DialogHeader>
          <FormError message={fieldErrors.non_field_errors ?? fieldErrors.detail} />
          <FormField control={form.control} name="product_id" label="Product" serverError={fieldErrors.product_id}>
            {(field) =>
              existing ? (
                <Input id={field.id} value={existing.product.name} readOnly disabled />
              ) : (
                <Select
                  value={field.value}
                  onValueChange={(v) => {
                    field.onChange(v);
                    const p = options.find((o) => o.id === v);
                    if (p) {
                      // With a price book the server prices the line from the book; leave the price blank.
                      if (!deal.price_book) form.setValue("unit_price", p.unit_price);
                      form.setValue("tax_rate", p.tax_rate);
                    }
                  }}
                >
                  <SelectTrigger id={field.id} aria-invalid={field["aria-invalid"]} aria-describedby={field["aria-describedby"]}>
                    <SelectValue placeholder={products.isPending ? "Loading…" : "Choose a product"} />
                  </SelectTrigger>
                  <SelectContent>
                    {options.length === 0 && !products.isPending ? <div className="px-2 py-1.5 text-sm text-fg-muted">No active products.</div> : null}
                    {options.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                        {p.sku ? ` · ${p.sku}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
            }
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField control={form.control} name="quantity" label="Quantity" serverError={fieldErrors.quantity}>
              {(field) => <Input {...field} inputMode="decimal" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
            </FormField>
            <FormField control={form.control} name="unit_price" label={`Unit price (${existing?.currency ?? selected?.currency ?? deal.currency})`} serverError={fieldErrors.unit_price}>
              {(field) => <Input {...field} inputMode="decimal" placeholder={selected?.unit_price ?? "List price"} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
            </FormField>
            <FormField control={form.control} name="discount_percent" label="Discount (%)" serverError={fieldErrors.discount_percent}>
              {(field) => <Input {...field} inputMode="decimal" placeholder="0" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
            </FormField>
            <FormField control={form.control} name="tax_rate" label="Tax rate (%)" serverError={fieldErrors.tax_rate}>
              {(field) => <Input {...field} inputMode="decimal" placeholder="0" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
            </FormField>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {existing ? "Save changes" : "Add product"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
