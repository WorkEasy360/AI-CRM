"use client";

import { useSession } from "@/lib/session";

/**
 * Mounting the session query on the auth pages primes the CSRF cookie
 * (GET /api/v1/session/ sets it) before any POST is attempted. A 401 here is
 * expected and ignored; no redirect handler is registered on these pages.
 */
export function CsrfBootstrap() {
  useSession();
  return null;
}
