import type { Metadata } from "next";
import { Building2 } from "lucide-react";
import { ComingSoon } from "@/components/coming-soon";

export const metadata: Metadata = { title: "Companies" };

export default function CompaniesPage() {
  return <ComingSoon title="Companies" phase="Phase 2" icon={<Building2 />} description="Accounts, hierarchies and ownership." />;
}
