import type { Metadata } from "next";
import { WhatsAppSettingsPage } from "@/components/settings/whatsapp-settings-page";

export const metadata: Metadata = { title: "WhatsApp" };

export default function Page() {
  return <WhatsAppSettingsPage />;
}
