import type { Metadata, Viewport } from "next";
import "@/styles/globals.css";
import { Providers } from "@/app/providers";
import { ServiceWorkerRegistration } from "@/components/pwa/service-worker-registration";

export const metadata: Metadata = {
  title: { default: "Keel CRM", template: "%s · Keel CRM" },
  description: "Keel CRM",
  applicationName: "Keel CRM",
  robots: { index: false, follow: false },
  // The manifest link itself comes from app/manifest.ts.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/icons/icon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: { capable: true, title: "Keel", statusBarStyle: "default" },
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
    { media: "(prefers-color-scheme: light)", color: "#f5f9fd" },
    { media: "(prefers-color-scheme: dark)", color: "#f5f9fd" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
