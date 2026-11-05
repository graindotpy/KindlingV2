import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Kindling — Your next great read", template: "%s | Kindling" },
  description: "Find and request ebooks and audiobooks for your household. Follow every book from request to ready.",
  applicationName: "Kindling",
};

export const viewport: Viewport = { colorScheme: "light", themeColor: "#f7f7ef" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
