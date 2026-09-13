"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Archive, ArchiveRestore, MoreHorizontal, Pencil } from "lucide-react";
import { CustomFieldsSummary, useCustomFields } from "@/components/crm/custom-fields-form";
import { NotesPanel } from "@/components/crm/notes-panel";
import { ProductFormDialog } from "@/components/crm/products/product-form-dialog";
import { StatusBadge } from "@/components/crm/products/products-page";
import { Facts, RecordPage, RecordPageError, RecordPageSkeleton, Section } from "@/components/crm/record-page";
import { TagPicker } from "@/components/crm/tag-picker";
import { Timeline } from "@/components/crm/timeline";
import { useArchiveRestore } from "@/components/crm/use-record-mutations";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { getProduct } from "@/lib/api/crm";
import type { Product } from "@/lib/api/crm-types";
import { formatMoney, formatNumber } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { can, canEditRecord } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { formatDateTime } from "@/lib/utils";

export function ProductDetailPage({ id }: { id: string }) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const query = useQuery({ queryKey: crmKeys.record("products", id), queryFn: () => getProduct(id) });
  const { definitions } = useCustomFields("product");
  const { archive, restore } = useArchiveRestore("product");
  const [editOpen, setEditOpen] = React.useState(false);

  if (query.isPending) return <RecordPageSkeleton />;
  if (query.isError) return <RecordPageError error={query.error} backHref="/products" backLabel="Products" />;

  const product: Product = query.data;
  const canEdit = canEditRecord(active, "products", product.owner?.id);
  const canDelete = can(active, "products.delete");

  const overview = (
    <div className="flex flex-col gap-4">
      <Section title="Pricing">
        <Facts
          items={[
            { label: "Unit price", value: formatMoney(product.unit_price, product.currency) },
            { label: "Currency", value: product.currency },
            { label: "Tax rate", value: `${formatNumber(product.tax_rate)}%${product.tax_label ? ` ${product.tax_label}` : ""}` },
            { label: "SKU", value: product.sku ? <span className="font-mono text-xs">{product.sku}</span> : "" },
          ]}
        />
      </Section>
      {definitions.length > 0 ? (
        <Section title="Custom fields">
          <CustomFieldsSummary definitions={definitions} value={product.custom_data} />
        </Section>
      ) : null}
      {product.description ? (
        <Section title="Description">
          <p className="whitespace-pre-wrap break-words text-sm">{product.description}</p>
        </Section>
      ) : null}
    </div>
  );

  return (
    <>
      <RecordPage
        backHref="/products"
        backLabel="Products"
        title={product.name}
        subtitle={product.sku ? <span className="font-mono">SKU {product.sku}</span> : undefined}
        badges={<StatusBadge status={product.status} />}
        archived={Boolean(product.archived_at)}
        actions={
          <>
            {canEdit ? (
              <Button variant="secondary" onClick={() => setEditOpen(true)}>
                <Pencil /> Edit
              </Button>
            ) : null}
            {canDelete ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {product.archived_at ? (
                    <DropdownMenuItem onSelect={() => restore.mutate(product.id)}>
                      <ArchiveRestore /> Restore
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem destructive onSelect={() => archive.mutate(product.id)}>
                      <Archive /> Archive
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        }
        tabs={[
          { value: "overview", label: "Overview", content: overview },
          { value: "notes", label: "Notes", content: <NotesPanel entity="product" recordId={product.id} /> },
          { value: "timeline", label: "Timeline", content: <Timeline entity="product" recordId={product.id} /> },
        ]}
        aside={
          <>
            <Section title="Owner">
              <p className="text-sm">{product.owner?.display_name ?? <span className="text-fg-subtle">Unassigned</span>}</p>
            </Section>
            <Section title="Tags">
              <TagPicker entity="product" recordId={product.id} current={product.tags} disabled={!canEdit} />
            </Section>
            <Section title="Record">
              <dl className="grid gap-2 text-sm">
                <div>
                  <dt className="text-xs text-fg-subtle">Created</dt>
                  <dd>{formatDateTime(product.created_at)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-fg-subtle">Updated</dt>
                  <dd>{formatDateTime(product.updated_at)}</dd>
                </div>
                {product.archived_at ? (
                  <div>
                    <dt className="text-xs text-fg-subtle">Archived</dt>
                    <dd>{formatDateTime(product.archived_at)}</dd>
                  </div>
                ) : null}
              </dl>
            </Section>
          </>
        }
      />
      <ProductFormDialog open={editOpen} product={product} onOpenChange={setEditOpen} />
    </>
  );
}
