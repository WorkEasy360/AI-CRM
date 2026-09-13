import type { Metadata } from "next";
import { LayoutDashboard } from "lucide-react";
import { ComingSoon } from "@/components/coming-soon";

export const metadata: Metadata = { title: "Dashboard" };

export default function DashboardPage() {
  return <ComingSoon title="Dashboard" phase="Phase 2" icon={<LayoutDashboard />} description="Your pipeline at a glance: open deals, activity and targets." />;
}
