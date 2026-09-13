import type { Metadata } from "next";
import { TeamsPage } from "@/components/settings/teams-page";

export const metadata: Metadata = { title: "Teams" };

export default function Page() {
  return <TeamsPage />;
}
