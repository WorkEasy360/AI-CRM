import type { Metadata } from "next";
import { DataPage } from "@/components/settings/data-page";

export const metadata: Metadata = { title: "Data" };

export default function Page() {
  return <DataPage />;
}
