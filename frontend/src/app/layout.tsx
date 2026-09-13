import type { Metadata, Viewport } from "next";
import "@/styles/globals.css";
import { Providers } from "@/app/providers";

export const metadata: Metadata = {
  title: { default: "Keel CRM", template: "%s · Keel CRM" },
  description: "Keel CRM",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f8fa" },
    { media: "(prefers-color-scheme: dark)", color: "#0c1016" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
