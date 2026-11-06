import type { Metadata } from "next";
import { MessageTemplatesPage } from "@/components/settings/message-templates-page";

export const metadata: Metadata = { title: "Message Templates" };

export default function Page() {
  return <MessageTemplatesPage />;
}
