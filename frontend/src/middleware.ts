import { NextResponse, type NextRequest } from "next/server";

/**
 * Security headers with a per-request CSP nonce.
 *
 * - script-src uses a nonce + 'strict-dynamic' so only scripts Next.js emits
 *   with the nonce (and scripts they load) may run. No 'unsafe-inline'.
 * - style-src keeps 'unsafe-inline': Next.js and Tailwind v4 inject inline
 *   <style> elements (dev HMR, streaming), and Radix sets inline style
 *   attributes for positioning. Hash-based styles are a follow-up.
 * - 'unsafe-eval' is added ONLY outside production: the Next.js dev server
 *   (React Refresh / eval-based source maps) needs it. Production builds
 *   never include it.
 */
export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const isProduction = process.env.NODE_ENV === "production";

  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isProduction ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "manifest-src 'self'",
    "worker-src 'self' blob:",
  ];
  if (isProduction) directives.push("upgrade-insecure-requests");
  const csp = directives.join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Next.js reads the CSP from the request headers to stamp the nonce onto its own scripts.
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set(
    "Permissions-Policy",
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()",
  );
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return response;
}

export const config = {
  matcher: [
    {
      /*
       * Apply to all routes except:
       * - the proxied backend paths (/api, /_allauth, /health, /ready)
       * - Next.js internals and static assets
       */
      source: "/((?!api/|_allauth/|health/|ready/|_next/static|_next/image|favicon.ico|robots.txt).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
