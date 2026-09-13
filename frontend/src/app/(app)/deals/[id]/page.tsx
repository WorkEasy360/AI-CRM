import type { Metadata } from "next";
import { DealDetailPage } from "@/components/crm/deals/deal-detail-page";

export const metadata: Metadata = { title: "Deal" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DealDetailPage id={id} />;
}
