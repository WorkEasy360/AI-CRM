import type { Metadata } from "next";
import { HelpdeskPage } from "@/components/helpdesk/helpdesk-page";

export const metadata: Metadata = { title: "Helpdesk" };

export default function Page() {
  return <HelpdeskPage />;
}
