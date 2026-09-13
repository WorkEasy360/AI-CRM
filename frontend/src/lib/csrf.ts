/**
 * CSRF token reader.
 *
 * Django sets the CSRF cookie as `keel_csrftoken` in development and
 * `__Host-keel_csrftoken` in production (the __Host- prefix requires Secure,
 * Path=/ and no Domain). We accept whichever exists, preferring the
 * __Host- variant when both are present.
 */
export const CSRF_COOKIE_NAMES = ["__Host-keel_csrftoken", "keel_csrftoken"] as const;
export const CSRF_HEADER_NAME = "X-CSRFToken";

/** Read a single cookie value from a `document.cookie`-style string. */
export function readCookie(name: string, cookieString?: string): string | null {
  const source = cookieString ?? (typeof document === "undefined" ? "" : document.cookie);
  if (!source) return null;
  for (const part of source.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const key = eq === -1 ? trimmed : trimmed.slice(0, eq);
    if (key !== name) continue;
    const raw = eq === -1 ? "" : trimmed.slice(eq + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/** Return the CSRF token from whichever Keel CSRF cookie is present, or null. */
export function getCsrfToken(cookieString?: string): string | null {
  for (const name of CSRF_COOKIE_NAMES) {
    const value = readCookie(name, cookieString);
    if (value) return value;
  }
  return null;
}
