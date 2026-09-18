import type { Metadata } from "next";
import { WebhooksPage } from "@/components/settings/integrations/webhooks-page";

export const metadata: Metadata = { title: "Webhooks" };

export default function Page() {
  return <WebhooksPage />;
}
