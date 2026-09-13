"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Archive, ArrowRightLeft, Check, Package, Pencil, Plus, RotateCcw, Trash2, Users } from "lucide-react";
import { z } from "zod";
import { CustomFieldsSummary, useCustomFields } from "@/components/crm/custom-fields-form";
import { DealFormDialog } from "@/components/crm/deals/deal-form-dialog";
import { useMoveStage, type StageTarget } from "@/components/crm/deals/move-stage-dialog";
import { NotesPanel } from "@/components/crm/notes-panel";
import { StageBadge, StatusBadge } from "@/components/crm/pipeline/deals-list";
import { Facts, RecordPage, RecordPageError, RecordPageSkeleton, Section } from "@/components/crm/record-page";
import { TagPicker } from "@/components/crm/tag-picker";
import { Timeline } from "@/components/crm/timeline";
import { useArchiveRestore } from "@/components/crm/use-record-mutations";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import {
  addDealContact,
  addDealLine,
  dealContacts,
  dealHistory,
  dealLines,
  getDeal,
  listContacts,
  listPipelines,
  listProducts,
  removeDealContact,
  removeDealLine,
  updateDealLine,
} from "@/lib/api/crm";
import type { Deal, DealLine, DealLineInput, PipelineStage } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { formatDuration, formatMoney, formatNumber, stageDotClass } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { can, canEditRecord } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { cn, formatDate, formatDateTime } from "@/lib/utils";

const BACK = { href: "/pipeline", label: "Pipeline" };

export function DealDetailPage({ id }: { id: string }) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const baseCurrency = active?.organization.base_currency ?? "USD";
  const deal = useQuery({ queryKey: crmKeys.record("deals", id), queryFn: () => getDeal(id) });
  const pipelines = useQuery({ queryKey: crmKeys.pipelines, queryFn: () => listPipelines(), staleTime: 60_000 });
  const { definitions } = useCustomFields("deal");
  const { archive, restore } = useArchiveRestore("deal");
  const move = useMoveStage();
  const [editing, setEditing] = React.useState(false);
  const [confirmArchive, setConfirmArchive] = React.useState(false);

  if (deal.isPending) return <RecordPageSkeleton />;
  if (deal.isError) return <RecordPageError error={deal.error} backHref={BACK.href} backLabel={BACK.label} />;
  const record = deal.data;
  const archived = Boolean(record.archived_at);
  const editable = !archived && canEditRecord(active, "deals", record.owner?.id);
  const canMove = !archived && can(active, "deals.change_stage");
  const canArchive = !archived && can(active, "deals.delete");
  const canRestore = archived && can(active, "deals.restore");
  const pipeline = pipelines.data?.results.find((p) => p.id === record.pipeline.id) ?? null;
  const stages: PipelineStage[] = pipeline ? pipeline.stages.filter((s) => !s.archived_at) : [];
  const moveTargets: StageTarget[] = stages.filter((s) => s.id !== record.stage.id);

  const facts = [
    { label: "Amount", value: `${formatMoney(record.amount, record.currency)}${record.currency !== baseCurrency ? ` · ${formatMoney(record.amount_base, baseCurrency)} at ${record.exchange_rate}` : ""}` },
    { label: "Probability", value: `${record.probability}%` },
    { label: "Expected close", value: formatDate(record.expected_close_date) },
    { label: "Pipeline / stage", value: `${record.pipeline.name} · ${record.stage.name}` },
    {
      label: "Company",
      value: record.company ? (
        <Link href={`/companies/${encodeURIComponent(record.company.id)}`} className="text-primary hover:underline">
          {record.company.name}
        </Link>
      ) : (
        ""
      ),
    },
    {
      label: "Primary contact",
      value: record.primary_contact ? (
        <Link href={`/contacts/${encodeURIComponent(record.primary_contact.id)}`} className="text-primary hover:underline">
          {record.primary_contact.name}
        </Link>
      ) : (
        ""
      ),
    },
    ...(record.status !== "open" ? [{ label: record.status === "won" ? "Won on" : "Lost on", value: formatDateTime(record.closed_at) }] : []),
    ...(record.status === "lost" && record.lost_reason ? [{ label: "Lost reason", value: record.lost_reason }] : []),
    ...(record.products_total !== null ? [{ label: "Products total", value: formatMoney(record.products_total, record.currency) }] : []),
  ];

  return (
    <>
      <RecordPage
        backHref={BACK.href}
        backLabel="Back to pipeline"
        title={record.name}
        subtitle={<StageProgress stages={stages} current={record.stage} status={record.status} canMove={canMove} busy={move.isPending} onSelect={(s) => move.requestMove(record, s)} />}
        badges={<StatusBadge status={record.status} />}
        archived={archived}
        actions={
          <>
            {editable ? (
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            ) : null}
            {canMove && moveTargets.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" size="sm" loading={move.isPending}>
                    <ArrowRightLeft /> Move to…
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Move to stage</DropdownMenuLabel>
                  {moveTargets.map((s) => (
                    <DropdownMenuItem key={s.id} onSelect={() => move.requestMove(record, s)}>
                      {s.name}
                      {s.kind !== "open" ? <span className="ml-auto text-xs text-fg-subtle">{s.kind === "won" ? "Won" : "Lost"}</span> : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {canArchive ? (
              <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(true)}>
                <Archive /> Archive
              </Button>
            ) : null}
            {canRestore ? (
              <Button variant="secondary" size="sm" onClick={() => restore.mutate(record.id)} loading={restore.isPending}>
                <RotateCcw /> Restore
              </Button>
            ) : null}
          </>
        }
        tabs={[
          {
            value: "overview",
            label: "Overview",
            content: (
              <div className="flex flex-col gap-4">
                <Section title="Details">
                  <Facts items={facts} />
                </Section>
                {record.description ? (
                  <Section title="Description">
                    <p className="whitespace-pre-wrap break-words text-sm">{record.description}</p>
                  </Section>
                ) : null}
                {definitions.length > 0 ? (
                  <Section title="Custom fields">
                    <CustomFieldsSummary definitions={definitions} value={record.custom_data} />
                  </Section>
                ) : null}
              </div>
            ),
          },
          { value: "products", label: `Products${record.line_count ? ` (${record.line_count})` : ""}`, content: <LinesSection deal={record} editable={editable} /> },
          { value: "contacts", label: "Contacts", content: <ContactsSection deal={record} editable={editable} /> },
          { value: "history", label: "History", content: <HistorySection dealId={record.id} /> },
          { value: "notes", label: "Notes", content: <NotesPanel entity="deal" recordId={record.id} /> },
          { value: "timeline", label: "Timeline", content: <Timeline entity="deal" recordId={record.id} /> },
        ]}
        aside={
          <>
            <Section title="Owner">
              {record.owner ? (
                <div className="flex items-center gap-2">
                  <Avatar name={record.owner.display_name} size="sm" />
                  <span className="truncate text-sm">{record.owner.display_name}</span>
                </div>
              ) : (
                <p className="text-sm text-fg-subtle">Unassigned</p>
              )}
            </Section>
            <Section title="Tags">
              <TagPicker entity="deal" recordId={record.id} current={record.tags} disabled={!editable} />
            </Section>
            <Section title="Record">
              <Facts
                items={[
                  { label: "Stage since", value: formatDateTime(record.stage_entered_at) },
                  { label: "Created", value: formatDateTime(record.created_at) },
                  { label: "Updated", value: formatDateTime(record.updated_at) },
                  ...(record.archived_at ? [{ label: "Archived", value: formatDateTime(record.archived_at) }] : []),
                ]}
              />
            </Section>
          </>
        }
      />
      {move.dialog}
      <DealFormDialog open={editing} onOpenChange={setEditing} deal={record} pipelines={pipelines.data?.results ?? []} />
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={`Archive ${record.name}?`}
        description="The deal disappears from the board and lists. You can restore it later."
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
        onConfirm={() => archive.mutate(record.id, { onSuccess: () => setConfirmArchive(false) })}
      />
    </>
  );
}

/* ------------------------------------------------------------------ stage progress */

function StageProgress({
  stages,
  current,
  status,
  canMove,
  busy,
  onSelect,
}: {
  stages: PipelineStage[];
  current: Deal["stage"];
  status: Deal["status"];
  canMove: boolean;
  busy: boolean;
  onSelect: (stage: StageTarget) => void;
}) {
  if (stages.length === 0) {
    return (
      <span className="inline-flex items-center gap-2">
        <StageBadge name={current.name} colorToken={current.color_token} />
      </span>
    );
  }
  const currentIndex = stages.findIndex((s) => s.id === current.id);
  return (
    <ol className="mt-1 flex flex-wrap items-center gap-1" aria-label="Stage progress">
      {stages.map((stage, index) => {
        const isCurrent = stage.id === current.id;
        const reached = status === "open" ? currentIndex >= 0 && index < currentIndex : false;
        const classes = cn(
          "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors",
          isCurrent
            ? "border-primary bg-primary text-primary-fg"
            : reached
              ? "border-primary/40 bg-primary-soft text-primary"
              : "border-border bg-surface text-fg-muted",
          canMove && !isCurrent && "hover:border-primary hover:text-primary",
        );
        const inner = (
          <>
            <span className={cn("size-2 rounded-full", isCurrent ? "bg-primary-fg" : stageDotClass(stage.color_token))} aria-hidden />
            {stage.name}
            {isCurrent ? <Check className="size-3" aria-hidden /> : null}
          </>
        );
        return (
          <li key={stage.id} className="flex items-center">
            {canMove && !isCurrent ? (
              <button type="button" className={classes} onClick={() => onSelect(stage)} disabled={busy} aria-label={`Move to ${stage.name}`}>
                {inner}
              </button>
            ) : (
              <span className={classes} aria-current={isCurrent ? "step" : undefined}>
                {inner}
              </span>
            )}
            {index < stages.length - 1 ? <span className="mx-0.5 h-px w-2 bg-border-strong" aria-hidden /> : null}
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ product lines */

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

function LinesSection({ deal, editable }: { deal: Deal; editable: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const lines = useQuery({ queryKey: crmKeys.dealLines(deal.id), queryFn: () => dealLines(deal.id) });
  const [editing, setEditing] = React.useState<DealLine | "new" | null>(null);
  const [removing, setRemoving] = React.useState<DealLine | null>(null);

  const refresh = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: crmKeys.dealLines(deal.id) }), queryClient.invalidateQueries({ queryKey: crmKeys.record("deals", deal.id) })]);

  const remove = useMutation({
    mutationFn: (line: DealLine) => removeDealLine(deal.id, line.id),
    onSuccess: async () => {
      await refresh();
      setRemoving(null);
    },
    onError: (err) => toast({ tone: "error", title: "Could not remove product", description: errorMessage(err) }),
  });

  const items = lines.data?.results ?? [];
  const total = items.reduce((sum, l) => sum + Number(l.line_total || 0), 0);

  return (
    <Section
      title="Products"
      actions={
        editable ? (
          <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
            <Plus /> Add product
          </Button>
        ) : undefined
      }
    >
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
              <TableHead className="text-right">Line total</TableHead>
              {editable ? <TableHead className="w-20"><span className="sr-only">Actions</span></TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((line) => (
              <TableRow key={line.id}>
                <TableCell>
                  <div className="font-medium">{line.product.name}</div>
                  {line.sku ? <div className="text-xs text-fg-subtle">{line.sku}</div> : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(line.quantity)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatMoney(line.unit_price, line.currency)}</TableCell>
                <TableCell className="text-right tabular-nums">{Number(line.discount_percent) ? `${formatNumber(line.discount_percent)}%` : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{Number(line.tax_rate) ? `${formatNumber(line.tax_rate)}%` : "—"}</TableCell>
                <TableCell className="text-right font-medium tabular-nums">{formatMoney(line.line_total, line.currency)}</TableCell>
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
            <TableRow className="bg-surface-sunken font-semibold hover:bg-surface-sunken">
              <TableCell colSpan={5} className="text-right">
                Total
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatMoney(total, deal.currency)}</TableCell>
              {editable ? <TableCell /> : null}
            </TableRow>
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
        discount_percent: existing ? existing.discount_percent : "",
        tax_rate: existing ? existing.tax_rate : "",
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
            <DialogDescription>Leave the price blank to use the product&apos;s list price. Totals are computed on save.</DialogDescription>
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
                      form.setValue("unit_price", p.unit_price);
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

/* ------------------------------------------------------------------ linked contacts */

function ContactsSection({ deal, editable }: { deal: Deal; editable: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const links = useQuery({ queryKey: crmKeys.dealContacts(deal.id), queryFn: () => dealContacts(deal.id) });
  const [adding, setAdding] = React.useState(false);
  const [contactId, setContactId] = React.useState("");
  const [roleLabel, setRoleLabel] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const contactParams = React.useMemo(() => ({ sort: "name", ...(deal.company ? { company: deal.company.id } : {}) }), [deal.company]);
  const contacts = useQuery({
    queryKey: crmKeys.list("contacts", { ...contactParams, picker: "deal-link" }),
    queryFn: () => listContacts(contactParams),
    enabled: adding,
    staleTime: 60_000,
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: crmKeys.dealContacts(deal.id) }),
      queryClient.invalidateQueries({ queryKey: crmKeys.timeline("deal", deal.id) }),
    ]);

  const add = useMutation({
    mutationFn: () => addDealContact(deal.id, contactId, roleLabel.trim()),
    onSuccess: async () => {
      await refresh();
      setAdding(false);
      setContactId("");
      setRoleLabel("");
      setError(null);
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeDealContact(deal.id, id),
    onSuccess: refresh,
    onError: (err) => toast({ tone: "error", title: "Could not remove contact", description: errorMessage(err) }),
  });

  const items = links.data?.results ?? [];
  const linkedIds = new Set(items.map((l) => l.contact.id));
  const options = (contacts.data?.results ?? []).filter((c) => !linkedIds.has(c.id));
  const roleId = React.useId();
  const contactSelectId = React.useId();

  return (
    <Section
      title="Contacts"
      actions={
        editable ? (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            <Plus /> Link contact
          </Button>
        ) : undefined
      }
    >
      {links.isPending ? (
        <SkeletonRows rows={2} />
      ) : links.isError ? (
        <p className="text-sm text-danger">{errorMessage(links.error)}</p>
      ) : items.length === 0 ? (
        <EmptyState icon={<Users />} title="No linked contacts" description="Link the people involved in this deal and note their role." className="py-8" />
      ) : (
        <ul className="divide-y divide-border">
          {items.map((link) => (
            <li key={link.id} className="flex items-center gap-3 py-2">
              <Avatar name={link.contact.name} size="sm" />
              <div className="min-w-0 flex-1">
                <Link href={`/contacts/${encodeURIComponent(link.contact.id)}`} className="block truncate text-sm font-medium hover:text-primary hover:underline">
                  {link.contact.name}
                </Link>
                <div className="truncate text-xs text-fg-subtle">{[link.role_label, link.contact.email].filter(Boolean).join(" · ")}</div>
              </div>
              {editable ? (
                <Button
                  variant="danger-ghost"
                  size="sm"
                  onClick={() => remove.mutate(link.contact.id)}
                  loading={remove.isPending && remove.variables === link.contact.id}
                  aria-label={`Unlink ${link.contact.name}`}
                >
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={adding}
        onOpenChange={(open) => {
          setAdding(open);
          if (!open) setError(null);
        }}
      >
        <DialogContent>
          <form
            className="grid gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!contactId) {
                setError("Choose a contact.");
                return;
              }
              add.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>Link a contact</DialogTitle>
              <DialogDescription>{deal.company ? `Showing contacts at ${deal.company.name}.` : "Choose a contact and describe their role."}</DialogDescription>
            </DialogHeader>
            <FormError message={error} />
            <div className="flex flex-col gap-1.5">
              <label htmlFor={contactSelectId} className="text-sm font-medium">
                Contact
              </label>
              <Select value={contactId} onValueChange={setContactId}>
                <SelectTrigger id={contactSelectId}>
                  <SelectValue placeholder={contacts.isPending ? "Loading…" : "Choose a contact"} />
                </SelectTrigger>
                <SelectContent>
                  {options.length === 0 && !contacts.isPending ? <div className="px-2 py-1.5 text-sm text-fg-muted">No more contacts to link.</div> : null}
                  {options.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={roleId} className="text-sm font-medium">
                Role (optional)
              </label>
              <Input id={roleId} value={roleLabel} onChange={(e) => setRoleLabel(e.target.value)} maxLength={60} placeholder="Decision maker, Champion, Legal…" />
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={add.isPending}>
                Link contact
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

/* ------------------------------------------------------------------ stage history */

function HistorySection({ dealId }: { dealId: string }) {
  const history = useQuery({ queryKey: crmKeys.dealHistory(dealId), queryFn: () => dealHistory(dealId) });
  const items = history.data?.results ?? [];
  return (
    <Section title="Stage history">
      {history.isPending ? (
        <SkeletonRows rows={3} />
      ) : history.isError ? (
        <p className="text-sm text-danger">{errorMessage(history.error)}</p>
      ) : items.length === 0 ? (
        <EmptyState title="No stage changes yet" className="py-8" />
      ) : (
        <Table>
          <caption className="sr-only">Stage history, newest first</caption>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>From</TableHead>
              <TableHead>To</TableHead>
              <TableHead>By</TableHead>
              <TableHead className="text-right">Time in previous stage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="whitespace-nowrap text-fg-muted">{formatDateTime(entry.changed_at)}</TableCell>
                <TableCell>{entry.from_stage ? <StageBadge name={entry.from_stage.name} colorToken={entry.from_stage.color_token} /> : <span className="text-fg-subtle">—</span>}</TableCell>
                <TableCell>
                  <StageBadge name={entry.to_stage.name} colorToken={entry.to_stage.color_token} />
                </TableCell>
                <TableCell>{entry.changed_by?.display_name ?? (entry.source && entry.source !== "user" ? entry.source : "—")}</TableCell>
                <TableCell className="text-right tabular-nums">{formatDuration(entry.duration_seconds) || "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}
