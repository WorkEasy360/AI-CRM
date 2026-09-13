import type { Metadata } from "next";
import { KanbanSquare } from "lucide-react";
import { ComingSoon } from "@/components/coming-soon";

export const metadata: Metadata = { title: "Pipeline" };

export default function PipelinePage() {
  return <ComingSoon title="Pipeline" phase="Phase 2" icon={<KanbanSquare />} description="Deals by stage, drag to move, forecast by close date." />;
}
