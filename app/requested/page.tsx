import type { Metadata } from "next";
import { KindlingScreen } from "@/components/kindling-screen";

export const metadata: Metadata = { title: "Household" };

export default function RequestedPage() {
  return <KindlingScreen screen="requested" />;
}
