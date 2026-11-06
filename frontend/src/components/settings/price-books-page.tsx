"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { BookOpen, MoreHorizontal, Pencil, Plus, Power, PowerOff, Trash2, X } from "lucide-react";
import { z } from "zod";
import "@/lib/zod-config";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import {
  archivePriceBook,
  createPriceBook,
  listPriceBooks,
  listProducts,
  priceBookEntries,
  setPriceBookEntries,
  updatePriceBook,
} from "@/lib/api/crm";
import type { PriceBook, PriceBookEntry } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { useDebounced } from "@/lib/crm/use-list-params";
import { hasPermission, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

const PRICE = /^\d{1,16}(\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

const bookSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120, "Name is too long."),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .refine((v) => CURRENCY.test(v), "Use a 3-letter currency code, e.g. USD."),
  description: z.string().max(2000, "Description is too long."),
});
type BookFormValues = z.infer<typeof bookSchema>;

export function PriceBooksPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canView = hasPermission(active, "products.view");
  const canManage = hasPermission(active, "pricebooks.manage");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [editing, setEditing] = React.useState<PriceBook | "new" | null>(null);
  const [archiving, setArchiving] = React.useState<PriceBook | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const books = useQuery({ queryKey: crmKeys.priceBooks, queryFn: listPriceBooks, enabled: canView });

  const toggle = useMutation({
    mutationFn: (book: PriceBook) => updatePriceBook(book.id, { is_active: !book.is_active, version: book.version }),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: crmKeys.priceBooks });
      toast({ tone: "success", title: saved.is_active ? "Price book activated" : "Price book deactivated", description: saved.name });
    },
    onError: (err) => toast({ tone: "error", title: "Could not update price book", description: errorMessage(err) }),
  });

  const archive = useMutation({
    mutationFn: (id: string) => archivePriceBook(id),
    onSuccess: async (_data, id) => {
      await queryClient.invalidateQueries({ queryKey: crmKeys.priceBooks });
      if (selectedId === id) setSelectedId(null);
      setArchiving(null);
      toast({ tone: "success", title: "Price book archived" });
    },
    onError: (err) => toast({ tone: "error", title: "Could not archive price book", description: errorMessage(err) }),
  });

  if (!canView) {
    return (
      <div>
        <PageHeader title="Price books" />
        <EmptyState icon={<BookOpen />} title="No access" description="Your role does not include permission to view products." />
      </div>
    );
  }

  const rows = (books.data?.results ?? []).filter((b) => !b.archived_at).sort((a, b) => a.name.localeCompare(b.name));
  const selected = rows.find((b) => b.id === selectedId) ?? null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Price books"
        description="Special prices for your products, one currency per book. Pick a price book on a deal to use its prices."
        actions={
          canManage ? (
            <Button onClick={() => setEditing("new")}>
              <Plus /> New price book
            </Button>
          ) : null
        }
      />

      {books.isPending ? (
        <SkeletonRows rows={3} />
      ) : books.isError ? (
        <EmptyState
          title="Could not load price books"
          description={errorMessage(books.error)}
          action={
            <Button variant="secondary" onClick={() => books.refetch()}>
              Retry
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<BookOpen />}
          title="No price books yet"
          description="Create one for a customer group, region or currency."
          action={canManage ? <Button onClick={() => setEditing("new")}>Create a price book</Button> : null}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Currency</TableHead>
              <TableHead className="hidden sm:table-cell">Products</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-36">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((book) => (
              <TableRow key={book.id} className={cn(book.id === selectedId && "bg-primary-soft/40")}>
                <TableCell>
                  <span className="block font-medium">{book.name}</span>
                  {book.description ? <span className="block max-w-sm truncate text-xs text-fg-subtle">{book.description}</span> : null}
                </TableCell>
                <TableCell className="font-mono text-xs">{book.currency}</TableCell>
                <TableCell className="hidden text-fg-muted sm:table-cell">{book.entry_count.toLocaleString()}</TableCell>
                <TableCell>
                  <Badge variant={book.is_active ? "success" : "neutral"}>{book.is_active ? "Active" : "Inactive"}</Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setSelectedId(book.id === selectedId ? null : book.id)} aria-pressed={book.id === selectedId}>
                      Prices
                    </Button>
                    {canManage ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${book.name}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setEditing(book)}>
                            <Pencil /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => toggle.mutate(book)}>
                            {book.is_active ? <PowerOff /> : <Power />} {book.is_active ? "Deactivate" : "Activate"}
                          </DropdownMenuItem>
                          <DropdownMenuItem destructive onSelect={() => setArchiving(book)}>
                            <Trash2 /> Archive
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {selected ? <PriceBookEntries book={selected} canManage={canManage} onClose={() => setSelectedId(null)} /> : null}

      <PriceBookDialog book={editing} baseCurrency={active?.organization.base_currency} onOpenChange={(open) => !open && setEditing(null)} />
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={`Archive “${archiving?.name ?? "price book"}”?`}
        description="It can no longer be picked on deals. Deals that already use it keep their prices."
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
        onConfirm={() => archiving && archive.mutate(archiving.id)}
      />
    </div>
  );
}

export function PriceBookDialog({
  book,
  baseCurrency,
  onOpenChange,
}: {
  book: PriceBook | "new" | null;
  baseCurrency?: string;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const existing = book && book !== "new" ? book : null;

  const form = useForm<BookFormValues>({
    resolver: zodResolver(bookSchema),
    defaultValues: { name: "", currency: baseCurrency ?? "USD", description: "" },
  });

  React.useEffect(() => {
    if (book) {
      form.reset({ name: existing?.name ?? "", currency: existing?.currency ?? baseCurrency ?? "USD", description: existing?.description ?? "" });
      setFieldErrors({});
    }
  }, [book, existing, baseCurrency, form]);

  const mutation = useMutation({
    mutationFn: (values: BookFormValues) =>
      existing
        ? updatePriceBook(existing.id, { name: values.name, description: values.description, version: existing.version })
        : createPriceBook({ name: values.name, currency: values.currency, description: values.description }),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: crmKeys.priceBooks });
      toast({ tone: "success", title: existing ? "Price book updated" : "Price book created", description: saved.name });
      onOpenChange(false);
    },
    onError: (err) => {
      if (isApiError(err)) {
        if (err.isValidation) {
          setFieldErrors(err.fieldErrors());
          return;
        }
        if (err.status === 409) {
          setFieldErrors({ name: errorMessage(err) });
          return;
        }
      }
      toast({ tone: "error", title: "Could not save price book", description: errorMessage(err) });
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    setFieldErrors({});
    mutation.mutate(values);
  });

  return (
    <Dialog open={book !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{existing ? "Edit price book" : "New price book"}</DialogTitle>
            <DialogDescription>{existing ? "The currency can't change. Create a new price book for another currency." : "Prices in a book are all in one currency."}</DialogDescription>
          </DialogHeader>
          <FormError message={fieldErrors.non_field_errors ?? fieldErrors.version} />
          <FormField control={form.control} name="name" label="Name" serverError={fieldErrors.name}>
            {(f) => <Input {...f} autoFocus maxLength={120} placeholder="Wholesale" value={f.value} onChange={(e) => f.onChange(e.target.value)} />}
          </FormField>
          <FormField control={form.control} name="currency" label="Currency" serverError={fieldErrors.currency}>
            {(f) => (
              <Input
                {...f}
                maxLength={3}
                className="w-28 uppercase"
                autoCapitalize="characters"
                disabled={existing !== null}
                value={f.value}
                onChange={(e) => f.onChange(e.target.value)}
              />
            )}
          </FormField>
          <FormField control={form.control} name="description" label="Description" serverError={fieldErrors.description}>
            {(f) => <Textarea {...f} rows={2} maxLength={2000} value={f.value} onChange={(e) => f.onChange(e.target.value)} />}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {existing ? "Save changes" : "Create price book"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ entries */

function usePriceBookSave(book: PriceBook) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (entries: { product_id: string; unit_price: string | null }[]) => setPriceBookEntries(book.id, entries),
    onSuccess: async (result) => {
      queryClient.setQueryData(crmKeys.priceBookEntries(book.id), result);
      await queryClient.invalidateQueries({ queryKey: crmKeys.priceBooks, exact: true });
    },
    onError: (err) => toast({ tone: "error", title: "Could not save prices", description: errorMessage(err) }),
  });
}

export function PriceBookEntries({ book, canManage, onClose }: { book: PriceBook; canManage: boolean; onClose: () => void }) {
  const entries = useQuery({ queryKey: crmKeys.priceBookEntries(book.id), queryFn: () => priceBookEntries(book.id) });
  const save = usePriceBookSave(book);
  const rows = (entries.data?.results ?? []).slice().sort((a, b) => a.product.name.localeCompare(b.product.name));

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>
            Prices in {book.name} <span className="font-mono text-sm font-normal text-fg-muted">({book.currency})</span>
          </CardTitle>
          <CardDescription>Products without a price here use their own price.</CardDescription>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close prices">
          <X />
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4">
        {canManage ? <AddEntry book={book} existing={new Set(rows.map((r) => r.product.id))} /> : null}
        {entries.isPending ? (
          <SkeletonRows rows={3} />
        ) : entries.isError ? (
          <p className="text-sm text-danger">{errorMessage(entries.error)}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-fg-muted">No products in this price book yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="hidden text-right sm:table-cell">List price</TableHead>
                <TableHead className="w-48 text-right">Price in book</TableHead>
                {canManage ? (
                  <TableHead className="w-10">
                    <span className="sr-only">Remove</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((entry) => (
                <EntryRow key={entry.id} entry={entry} book={book} canManage={canManage} saving={save.isPending} onSave={(entries) => save.mutate(entries)} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function EntryRow({
  entry,
  book,
  canManage,
  saving,
  onSave,
}: {
  entry: PriceBookEntry;
  book: PriceBook;
  canManage: boolean;
  saving: boolean;
  onSave: (entries: { product_id: string; unit_price: string | null }[]) => void;
}) {
  const [value, setValue] = React.useState(entry.unit_price ?? "");
  React.useEffect(() => setValue(entry.unit_price ?? ""), [entry.unit_price]);
  const hidden = entry.unit_price === undefined;
  const trimmed = value.trim();
  const valid = PRICE.test(trimmed);
  const dirty = trimmed !== (entry.unit_price ?? "");
  const inputId = `price-${entry.id}`;

  return (
    <TableRow>
      <TableCell>
        <span className="block font-medium">{entry.product.name}</span>
        {entry.product.sku ? <span className="font-mono text-xs text-fg-subtle">{entry.product.sku}</span> : null}
      </TableCell>
      <TableCell className="hidden text-right tabular-nums text-fg-muted sm:table-cell">{entry.list_price === undefined ? "Hidden" : entry.list_price}</TableCell>
      <TableCell className="text-right">
        {hidden ? (
          <span className="text-fg-subtle">Hidden</span>
        ) : canManage ? (
          <form
            className="flex items-center justify-end gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (dirty && valid) onSave([{ product_id: entry.product.id, unit_price: trimmed }]);
            }}
          >
            <Label htmlFor={inputId} className="sr-only">
              Price for {entry.product.name}
            </Label>
            <Input
              id={inputId}
              inputMode="decimal"
              className="h-8 w-28 text-right tabular-nums"
              value={value}
              aria-invalid={(dirty && !valid) || undefined}
              onChange={(e) => setValue(e.target.value)}
            />
            {dirty ? (
              <Button type="submit" size="sm" disabled={!valid} loading={saving}>
                Save
              </Button>
            ) : null}
          </form>
        ) : (
          <span className="tabular-nums">{formatMoney(entry.unit_price, book.currency)}</span>
        )}
      </TableCell>
      {canManage ? (
        <TableCell>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${entry.product.name}`}
            disabled={saving}
            onClick={() => onSave([{ product_id: entry.product.id, unit_price: null }])}
          >
            <X />
          </Button>
        </TableCell>
      ) : null}
    </TableRow>
  );
}

function AddEntry({ book, existing }: { book: PriceBook; existing: Set<string> }) {
  const [query, setQuery] = React.useState("");
  const [productId, setProductId] = React.useState("");
  const [price, setPrice] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const debounced = useDebounced(query.trim(), 250);
  const save = usePriceBookSave(book);

  const products = useQuery({
    queryKey: crmKeys.list("products", { status: "active", sort: "name", q: debounced || undefined, picker: "price-book" }),
    queryFn: () => listProducts({ status: "active", sort: "name", q: debounced || undefined }),
    staleTime: 60_000,
  });
  const options = (products.data?.results ?? []).filter((p) => !existing.has(p.id));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!productId) {
      setError("Choose a product.");
      return;
    }
    if (!PRICE.test(price.trim())) {
      setError("Enter a price like 99 or 99.50.");
      return;
    }
    setError(null);
    save.mutate([{ product_id: productId, unit_price: price.trim() }], {
      onSuccess: () => {
        setProductId("");
        setPrice("");
      },
    });
  };

  return (
    <form onSubmit={submit} className="grid gap-2 rounded-sm border border-border bg-bg-subtle/40 p-3" aria-label="Add a product">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_8rem_auto] sm:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor="pb-search">Find product</Label>
          <Input id="pb-search" placeholder="Search by name or SKU" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pb-product">Product</Label>
          <Select value={productId} onValueChange={setProductId}>
            <SelectTrigger id="pb-product">
              <SelectValue placeholder={products.isPending ? "Loading…" : options.length ? "Choose a product" : "No products found"} />
            </SelectTrigger>
            <SelectContent>
              {options.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                  {p.sku ? <span className="ml-1 font-mono text-xs text-fg-subtle">{p.sku}</span> : null}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="pb-price">Price ({book.currency})</Label>
          <Input id="pb-price" inputMode="decimal" placeholder="0.00" value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
        <Button type="submit" loading={save.isPending}>
          <Plus /> Add
        </Button>
      </div>
      <FormError message={error} />
    </form>
  );
}
