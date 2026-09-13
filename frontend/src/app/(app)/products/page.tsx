import type { Metadata } from "next";
import * as React from "react";
import { ProductsPage } from "@/components/crm/products/products-page";
import { SkeletonRows } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Products" };

export default function Page() {
  return (
    <React.Suspense fallback={<SkeletonRows rows={6} />}>
      <ProductsPage />
    </React.Suspense>
  );
}
