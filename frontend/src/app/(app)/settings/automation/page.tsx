import type { Metadata } from "next";
import { AutomationPage } from "@/components/settings/automation-page";

export const metadata: Metadata = { title: "Automation" };

export default function Page() {
  return <AutomationPage />;
}
