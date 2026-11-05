import type { Metadata } from "next";
import { KindlingScreen } from "@/components/kindling-screen";

export const metadata: Metadata = { title: "My books" };

export default function BooksPage() {
  return <KindlingScreen screen="books" />;
}
