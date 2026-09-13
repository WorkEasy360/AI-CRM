/**
 * Full-page navigation to another origin (OAuth consent screens). Kept in its own module so
 * components can be tested without touching `window.location`, which jsdom does not let tests replace.
 */
export function navigateExternal(url: string): void {
  window.location.assign(url);
}

/** Only absolute https URLs are followed; anything else is treated as a broken server response. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
