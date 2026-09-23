/**
 * Starts `GET /api/v1/session/` while the HTML is still being parsed.
 *
 * Every page under `(app)` is gated on the session: `AuthGate` renders a skeleton until it resolves,
 * and no page mounts (so no page fetches its own data) before then. Measured on a production build,
 * that request only left the browser at ~130 ms - not because the server was slow (it answers in
 * ~80 ms) but because nothing asks for it until the route's JavaScript has downloaded, parsed and
 * hydrated. The list request followed at ~230 ms, once the session had come back.
 *
 * The `(app)` layout emits {@link SESSION_PRELOAD_SCRIPT} with the request's CSP nonce, so the fetch
 * starts as the browser reaches it (~15 ms) rather than after hydration, and every request behind it
 * moves up by the same amount. `getSession` then adopts the in-flight promise instead of issuing a
 * second request.
 *
 * What this deliberately does not do is inline the session payload into the HTML. Starting a
 * same-origin request the browser was always going to make exposes nothing new; embedding the
 * response would put the member's organization, role and permissions into the document itself.
 * Authorization is unaffected either way - the backend answers this request exactly as before, and
 * remains the only thing deciding what the session may see.
 */
const PRELOAD_KEY = "__keelSessionPreload";

/**
 * Failures resolve to `null` rather than rejecting: the caller then falls back to the normal client,
 * which reports the error with the app's own `ApiError` semantics (`isNotAuthenticated` and friends)
 * instead of a bare fetch rejection. A 401 therefore costs one extra request and behaves exactly as
 * it did before this existed.
 */
export const SESSION_PRELOAD_SCRIPT =
  `window.${PRELOAD_KEY}=fetch("/api/v1/session/",` +
  `{credentials:"include",cache:"no-store",headers:{Accept:"application/json"}})` +
  `.then(function(r){return r.ok?r.json():null}).catch(function(){return null});`;

type PreloadWindow = Window & { [PRELOAD_KEY]?: Promise<unknown> | null };

/**
 * Hands over the preloaded response, once. Later calls (a refetch after switching organization,
 * enabling MFA, editing the profile) must reach the server again, so the promise is cleared as it is
 * taken and every subsequent `getSession` makes a normal request.
 */
export function takePreloadedSession(): Promise<unknown> | null {
  if (typeof window === "undefined") return null;
  const w = window as PreloadWindow;
  const pending = w[PRELOAD_KEY] ?? null;
  if (pending) w[PRELOAD_KEY] = null;
  return pending;
}
