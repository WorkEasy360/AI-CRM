import type { Metadata } from "next";
import { PriceBooksPage } from "@/components/settings/price-books-page";

export const metadata: Metadata = { title: "Price books" };

export default function Page() {
  return <PriceBooksPage />;
}
