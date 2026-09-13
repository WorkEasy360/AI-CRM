import type { Metadata } from "next";
import { TagsPage } from "@/components/settings/tags-page";

export const metadata: Metadata = { title: "Tags" };

export default function Page() {
  return <TagsPage />;
}
