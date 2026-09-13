import type { Metadata } from "next";
import { Package } from "lucide-react";
import { ComingSoon } from "@/components/coming-soon";

export const metadata: Metadata = { title: "Products" };

export default function ProductsPage() {
  return <ComingSoon title="Products" phase="Phase 2" icon={<Package />} description="Your catalogue and price books." />;
}
