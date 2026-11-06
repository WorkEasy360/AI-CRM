import type { Metadata } from "next";
import { HelpArticlePage } from "@/components/help/help-center";

export const metadata: Metadata = { title: "Help Center" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <HelpArticlePage id={id} />;
}
