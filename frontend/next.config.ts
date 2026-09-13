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
