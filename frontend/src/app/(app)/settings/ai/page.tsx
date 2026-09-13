import type { Metadata } from "next";
import { AISettingsPage } from "@/components/settings/ai-settings-page";

export const metadata: Metadata = { title: "AI assistant" };

export default function Page() {
  return <AISettingsPage />;
}
