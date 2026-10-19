import type { Metadata, Viewport } from "next";
import "@/styles/globals.css";
import { Providers } from "@/app/providers";
import { ServiceWorkerRegistration } from "@/components/pwa/service-worker-registration";

export const metadata: Metadata = {
  title: { default: "WorkEasy CRM", template: "%s · WorkEasy CRM" },
  description: "WorkEasy CRM",
  applicationName: "WorkEasy CRM",
  robots: { index: false, follow: false },
  // The manifest link itself comes from app/manifest.ts.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: { capable: true, title: "WorkEasy", statusBarStyle: "default" },
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
    { media: "(prefers-color-scheme: light)", color: "#1b3040" },
    { media: "(prefers-color-scheme: dark)", color: "#1b3040" },
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
