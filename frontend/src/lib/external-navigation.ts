/**
 * Full-page navigation to another origin (OAuth consent screens). Kept in its own module so
 * components can be tested without touching `window.location`, which jsdom does not let tests replace.
 */
export function navigateExternal(url: string): void {
  window.location.assign(url);
}

/**
 * Like a server redirect: the current page leaves the history, so Back from where it lands does not
 * return to a page that would only send the browser on again (the direct-visit sign-in start).
 */
export function replaceLocation(url: string): void {
  window.location.replace(url);
}

/** Only absolute https URLs are followed; anything else is treated as a broken server response. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}
