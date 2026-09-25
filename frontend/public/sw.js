/*
 * Keel CRM service worker: installability and an offline page, nothing else.
 *
 * It never stores or serves CRM data. The only requests it touches are top-level page navigations,
 * and those always go to the network: every page is rendered per request with a fresh CSP nonce, so
 * a stored copy would replay an old nonce. Only when the network cannot be reached is the static
 * offline page shown instead. Backend paths (/api, /_allauth, probes), Next.js data and asset
 * requests, and anything that is not a GET navigation get no respondWith at all, so the browser
 * handles them exactly as it would without a service worker (the API's Cache-Control: no-store
 * included). Navigation preload stays off: the preloaded copy of a backend navigation the worker
 * does not answer (a file download, say) would be a second, wasted request.
 *
 * Kill switch: to retire the worker, deploy a sw.js whose activate handler calls
 * self.registration.unregister(). Browsers re-check this script on every navigation
 * (registered with updateViaCache "none"), so it takes effect on the next visit.
 */
const CACHE = "keel-offline-v1";
const OFFLINE_URL = "/offline.html";
const BACKEND_PREFIXES = ["/api/", "/_allauth/", "/health/", "/ready/"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload", credentials: "omit" })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.mode !== "navigate" || request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (BACKEND_PREFIXES.some((prefix) => url.pathname === prefix.slice(0, -1) || url.pathname.startsWith(prefix))) return;

  event.respondWith(
    fetch(request).catch(async () => {
      const offline = await caches.match(OFFLINE_URL, { cacheName: CACHE });
      return offline ?? Response.error();
    }),
  );
});
