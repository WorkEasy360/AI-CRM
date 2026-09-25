"use client";

import * as React from "react";

/**
 * Registers /sw.js, which only provides the offline page for navigations and never caches CRM data
 * (see public/sw.js). Production builds only: the dev server's HMR has no use for it. Secure contexts
 * only (HTTPS, or localhost for a local production build), which is also where browsers allow it.
 * `updateViaCache: "none"` makes every check fetch sw.js fresh, so a changed worker (or a kill switch)
 * is picked up on the next visit.
 */
export function ServiceWorkerRegistration() {
  React.useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => undefined);
  }, []);
  return null;
}
