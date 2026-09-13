"use client";

import * as React from "react";
import Link from "next/link";
import { Handshake, Plus } from "lucide-react";
import { DataTable, type Column } from "@/components/crm/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { listDeals } from "@/lib/api/crm";
import type { Deal } from "@/lib/api/crm-types";
import { formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { useCursorList } from "@/lib/use-cursor-list";
import { formatDate } from "@/lib/utils";

const enc = encodeURIComponent;

function statusVariant(status: Deal["status"]): "success" | "danger" | "primary" {
  if (status === "won") return "success";
  if (status === "lost") return "danger";
  return "primary";
}

const DEAL_COLUMNS: Column<Deal>[] = [
  { key: "name", header: "Deal", className: "min-w-40", render: (d) => d.name },
  { key: "stage", header: "Stage", render: (d) => d.stage.name },
  { key: "amount", header: "Amount", className: "text-right tabular-nums whitespace-nowrap", render: (d) => formatMoney(d.amount, d.currency) },
  {
    key: "status",
    header: "Status",
    className: "hidden md:table-cell",
    render: (d) => <Badge variant={statusVariant(d.status)}>{d.status === "open" ? "Open" : d.status === "won" ? "Won" : "Lost"}</Badge>,
  },
  { key: "close", header: "Expected close", className: "hidden md:table-cell whitespace-nowrap", render: (d) => formatDate(d.expected_close_date) },
];

/**
 * Deals linked to one contact or company, with a "New deal" link into the pipeline page that opens the
 * create dialog prefilled (`/pipeline?new=1&contact=…&company=…`).
 */
export function RecordDeals({
  filter,
  newDealHref,
  canCreate,
  emptyDescription,
}: {
  filter: { contact?: string; company?: string };
  newDealHref: string;
  canCreate: boolean;
  emptyDescription: string;
}) {
  const params = React.useMemo(() => ({ ...filter, sort: "-updated_at" }), [filter]);
  const deals = useCursorList<Deal>(crmKeys.list("deals", params), (cursor) => listDeals(params, cursor));
  const newDeal = (
    <Button asChild variant="secondary" size="sm">
      <Link href={newDealHref}>
        <Plus /> New deal
      </Link>
    </Button>
  );
  return (
    <div className="flex flex-col gap-3">
      {canCreate && deals.items.length > 0 ? <div className="flex justify-end">{newDeal}</div> : null}
      <DataTable
        rows={deals.items}
        columns={DEAL_COLUMNS}
        rowHref={(d) => `/deals/${enc(d.id)}`}
        isPending={deals.isPending}
        isError={deals.isError}
        error={deals.error}
        onRetry={() => deals.refetch()}
        empty={<EmptyState icon={<Handshake />} title="No deals yet" description={emptyDescription} className="py-8" action={canCreate ? newDeal : null} />}
        hasMore={deals.hasMore}
        onLoadMore={() => deals.loadMore()}
        isLoadingMore={deals.isLoadingMore}
        caption="Deals"
      />
    </div>
  );
}
