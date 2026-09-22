import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Backend paths are proxied in src/middleware.ts, which needs the request
  // URL untouched: every DRF path ends in "/", and the default 308 that strips
  // it would send Django a slashless path it 301s straight back (a loop).
  skipTrailingSlashRedirect: true,
  poweredByHeader: false,
  output: "standalone",
  // Build-only escape hatch: a running dev server holds .next/trace on Windows, so a verification
  // build can target another directory (NEXT_DIST_DIR=.next-build pnpm build). Unset in CI.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    /*
     * Keep visited/prefetched route payloads in the client router cache instead of re-fetching the
     * page shell from the server on every single navigation (the Next.js default for a dynamic
     * route is 0s, and every route here is dynamic because of the per-request CSP nonce).
     *
     * Safe because these payloads hold no tenant data: each page.tsx is a shell that renders one
     * client component, and every CRM record is fetched client-side through React Query, which has
     * its own freshness rules and is cleared with the tab. Verified against the built payloads —
     * they contain no session, organization, membership or permission fields. So this caches markup
     * structure only and cannot serve one member's data to another.
     */
    staleTimes: { dynamic: 180, static: 300 },
    // Import only the icons/primitives a page uses instead of each package's whole barrel file.
    // Cuts module count per route noticeably in dev and trims client bundles in prod.
    optimizePackageImports: [
      "lucide-react",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-select",
      "@radix-ui/react-tabs",
      "@radix-ui/react-toast",
    ],
  },
};

export default nextConfig;
