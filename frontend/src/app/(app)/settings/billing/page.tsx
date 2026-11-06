import type { Metadata } from "next";
import { BillingPage } from "@/components/settings/billing-page";

export const metadata: Metadata = { title: "Plan & usage" };

export default function Page() {
  return <BillingPage />;
}
