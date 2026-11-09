import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "@/styles/globals.css";
import { Providers } from "@/app/providers";
import { ServiceWorkerRegistration } from "@/components/pwa/service-worker-registration";

/** Inter, downloaded at build time and served from this origin (font-src 'self'); see tokens.css. */
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });

export const metadata: Metadata = {
  title: { default: "WorkEasyCRM", template: "%s · WorkEasyCRM" },
  description: "WorkEasyCRM: sales pipeline, contacts, activities, helpdesk and WorkEasy AI in one workspace.",
  applicationName: "WorkEasyCRM",
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
    { media: "(max-width: 47.99rem)", color: "#0a3a2c" },
    { media: "(prefers-color-scheme: light)", color: "#102d3d" },
    { media: "(prefers-color-scheme: dark)", color: "#102d3d" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
