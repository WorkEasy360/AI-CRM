import type { Metadata } from "next";
import { ApiKeysPage } from "@/components/settings/integrations/api-keys-page";

export const metadata: Metadata = { title: "API keys" };

export default function Page() {
  return <ApiKeysPage />;
}
