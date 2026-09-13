import { NextResponse, type NextRequest } from "next/server";

/**
 * Server-side only. The Django origin backend paths are proxied to. Never
 * exposed to the browser (not NEXT_PUBLIC_*).
 */
const API_INTERNAL_ORIGIN = (process.env.API_INTERNAL_ORIGIN ?? "http://localhost:8000").replace(/\/+$/, "");

const BACKEND_PREFIXES = ["/api/", "/_allauth/", "/health/", "/ready/"] as const;

function isBackendPath(pathname: string): boolean {
  return BACKEND_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix));
}

/**
 * Backend proxy + security headers.
 *
 * Backend paths (/api, /_allauth, /health/, /ready/) are proxied here rather
 * than through `rewrites()` in next.config.ts. Every DRF route ends in "/",
 * and a config rewrite matches `:path*` loosely and forwards the path with the
 * slash stripped, so Django (APPEND_SLASH) 301s back and the browser loops
 * until fetch fails. Middleware sees the request URL verbatim (with
 * `skipTrailingSlashRedirect` set so Next does not 308 it first) and forwards
 * it unchanged.
 *
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
  const { pathname, search } = request.nextUrl;
  if (isBackendPath(pathname)) {
    return NextResponse.rewrite(new URL(`${pathname}${search}`, API_INTERNAL_ORIGIN));
  }

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
    // Backend paths, proxied verbatim to API_INTERNAL_ORIGIN.
    "/api/:path*",
    "/_allauth/:path*",
    "/health/",
    "/ready/",
    {
      /*
       * Security headers on all routes except:
       * - the proxied backend paths (handled above, no CSP needed)
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
