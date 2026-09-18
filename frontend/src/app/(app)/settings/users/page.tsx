import type { Metadata } from "next";
import { MembersPage } from "@/components/settings/members-page";

export const metadata: Metadata = { title: "Users & Teams" };

export default function Page() {
  return <MembersPage />;
}
