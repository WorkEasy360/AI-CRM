import type { Metadata } from "next";
import { PipelinesPage } from "@/components/settings/pipelines-page";

export const metadata: Metadata = { title: "Pipelines" };

export default function Page() {
  return <PipelinesPage />;
}
