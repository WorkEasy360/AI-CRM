import type { Metadata } from "next";
import { CustomFieldsPage } from "@/components/settings/custom-fields-page";

export const metadata: Metadata = { title: "Custom fields" };

export default function Page() {
  return <CustomFieldsPage />;
}
