/**
 * Opening WorkEasy CRM directly (docs/workeasy360-sso.md, "Opening WorkEasy CRM directly"; Workeasy360
 * integration guide 6b).
 *
 * When Workeasy360 is the only sign-in, a visitor with no session of ours who asks for a page is sent
 * straight to /api/auth/workeasy360/start instead of to a sign-in page they would only click through.
 * Two things stop that from ever happening by itself when it should not:
 *
 *  - the signed-out marker: both sign-outs leave it, so a sign-out never ends in a silent sign-in;
 *  - the loop guard: a browser that started a sign-in less than a minute ago and still has no session
 *    (a dropped cookie, a failure the server did not report as `sso_error`) is shown the sign-in page
 *    instead of being sent round again.
 *
 * The sign-in page itself never starts anything: it does not use this module.
 */

/**
 * The marker. A session cookie (no Max-Age) so every tab of this browser sees it and it ends with the
 * browser session; readable by script because it carries no secret. Set by the sign-out (`logout()`),
 * cleared by a password sign-in here and by the Django callback of a Workeasy360 sign-in
 * (apps/accounts/workeasy360/views.py, SIGNED_OUT_MARKER_COOKIES - keep the names equal).
 *
 * Named like the CSRF cookie (lib/csrf.ts): `__Host-keel_signed_out` over https, where the prefix means
 * only this exact host can set it (a sibling subdomain can neither plant nor shadow it), and plain
 * `keel_signed_out` over http (a `__Host-` cookie needs Secure, which http cannot carry).
 */
export const SIGNED_OUT_COOKIE = "keel_signed_out";
export const SIGNED_OUT_HOST_COOKIE = `__Host-${SIGNED_OUT_COOKIE}`;
const SIGNED_OUT_COOKIE_NAMES = [SIGNED_OUT_HOST_COOKIE, SIGNED_OUT_COOKIE] as const;

/** The loop guard: when this tab last started a sign-in by itself (epoch ms, sessionStorage). */
export const AUTO_START_STORAGE_KEY = "keel.sso.auto-start";
export const AUTO_START_WINDOW_MS = 60_000;

const onHttps = () => typeof location !== "undefined" && location.protocol === "https:";

function attributes(): string {
  return `; Path=/; SameSite=Lax${onHttps() ? "; Secure" : ""}`;
}

export function markSignedOut(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${onHttps() ? SIGNED_OUT_HOST_COOKIE : SIGNED_OUT_COOKIE}=1${attributes()}`;
}

/** Remove the marker under both names (the one this origin writes, and the other if it ever got there). */
export function clearSignedOutMarker(): void {
  if (typeof document === "undefined") return;
  for (const name of SIGNED_OUT_COOKIE_NAMES) {
    // A `__Host-` cookie cannot be written, so not removed either, from an origin without Secure.
    if (name === SIGNED_OUT_HOST_COOKIE && !onHttps()) continue;
    document.cookie = `${name}=; Max-Age=0${attributes()}`;
  }
}

/**
 * Whether the marker is set. Every cookie of that name counts, not the first: `document.cookie` lists
 * duplicates (one per Domain/Path it was set with) and the first one is not necessarily ours, so a
 * look-alike earlier in the string must not hide the real marker.
 */
export function hasSignedOutMarker(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie.split(";").some((part) => {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) return false;
    const key = trimmed.slice(0, eq);
    return (SIGNED_OUT_COOKIE_NAMES as readonly string[]).includes(key) && trimmed.slice(eq + 1) === "1";
  });
}

function guardStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Whether this browser may start a Workeasy360 sign-in by itself right now, and if so records that it
 * did. False after a sign-out (the marker), within a minute of the last automatic start, and whenever
 * the start cannot be recorded (storage blocked): an automatic start that cannot be remembered could
 * not be stopped from repeating, so the sign-in page is shown instead.
 */
export function claimAutoStart(now: number = Date.now()): boolean {
  if (hasSignedOutMarker()) return false;
  const storage = guardStorage();
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(AUTO_START_STORAGE_KEY));
    const age = now - last;
    if (Number.isFinite(last) && last > 0 && age >= 0 && age < AUTO_START_WINDOW_MS) return false;
    storage.setItem(AUTO_START_STORAGE_KEY, String(now));
    return storage.getItem(AUTO_START_STORAGE_KEY) === String(now);
  } catch {
    return false;
  }
}

/** A session now exists, so "started but still no session" no longer holds. */
export function clearAutoStartGuard(): void {
  try {
    guardStorage()?.removeItem(AUTO_START_STORAGE_KEY);
  } catch {
    // Storage unavailable: claimAutoStart() then refuses to start anything, so there is nothing to clear.
  }
}
