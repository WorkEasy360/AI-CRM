import type { Metadata, Viewport } from "next";
import "@/styles/globals.css";
import { Providers } from "@/app/providers";

export const metadata: Metadata = {
  title: { default: "Keel CRM", template: "%s · Keel CRM" },
  description: "Keel CRM",
  robots: { index: false, follow: false },
};

/**
 * Every page is rendered per request. The middleware issues a fresh CSP nonce on each response and
 * Next.js only stamps that nonce onto its own <script> tags while rendering dynamically; a page
 * prerendered at build time ships nonce-less scripts that `script-src 'nonce-…' 'strict-dynamic'`
 * blocks, and the app never hydrates. The dev server always renders dynamically, which is why this
 * only shows in a production build. Pages hold no server-fetched CRM data, so there is nothing to lose.
 */
export const dynamic = "force-dynamic";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f8fa" },
    { media: "(prefers-color-scheme: dark)", color: "#f7f8fa" },
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
