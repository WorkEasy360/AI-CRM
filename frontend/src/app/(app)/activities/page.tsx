import type { Metadata } from "next";
import { Activity } from "lucide-react";
import { ComingSoon } from "@/components/coming-soon";

export const metadata: Metadata = { title: "Activities" };

export default function ActivitiesPage() {
  return <ComingSoon title="Activities" phase="Phase 2" icon={<Activity />} description="Calls, meetings, emails and tasks in one timeline." />;
}
