import type { Metadata } from "next";
import { OrganizationPage } from "@/components/settings/organization-page";

export const metadata: Metadata = { title: "Organization settings" };

export default function Page() {
  return <OrganizationPage />;
}
