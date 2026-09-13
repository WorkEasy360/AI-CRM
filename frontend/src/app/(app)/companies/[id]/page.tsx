import type { Metadata } from "next";
import { CompanyDetailPage } from "@/components/crm/companies/company-detail-page";

export const metadata: Metadata = { title: "Company" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CompanyDetailPage id={id} />;
}
