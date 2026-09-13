import type { NextConfig } from "next";

/**
 * Server-side only. The Django origin the dev server proxies API calls to.
 * Never exposed to the browser (not NEXT_PUBLIC_*).
 */
const API_INTERNAL_ORIGIN = (process.env.API_INTERNAL_ORIGIN ?? "http://localhost:8000").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${API_INTERNAL_ORIGIN}/api/:path*` },
      { source: "/_allauth/:path*", destination: `${API_INTERNAL_ORIGIN}/_allauth/:path*` },
      { source: "/health/", destination: `${API_INTERNAL_ORIGIN}/health/` },
      { source: "/ready/", destination: `${API_INTERNAL_ORIGIN}/ready/` },
    ];
  },
};

export default nextConfig;
