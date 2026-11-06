import type { Metadata } from "next";
import { KnowledgeBasePage } from "@/components/settings/knowledge-base-page";

export const metadata: Metadata = { title: "Knowledge Base" };

export default function Page() {
  return <KnowledgeBasePage />;
}
