import type { Metadata } from "next";
import { BarChart3 } from "lucide-react";
import { ComingSoon } from "@/components/coming-soon";

export const metadata: Metadata = { title: "Reports" };

export default function ReportsPage() {
  return <ComingSoon title="Reports" phase="Phase 3" icon={<BarChart3 />} description="Pipeline, conversion and rep performance reporting." />;
}
