"use client";

import * as React from "react";

/** Tailwind's `max-md`. Keep the two in step: the phone screens and their CSS switch at the same width. */
const PHONE = "(max-width: 47.99rem)";

const media = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(PHONE) : null);

function subscribe(onChange: () => void): () => void {
  const query = media();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

/**
 * Whether the app is on a phone-sized screen, for the few screens that are built differently there
 * rather than restyled. False on the server, so use it only below the session gate, which renders on
 * the client; anything drawn before that switches with CSS instead (see PhoneWelcome).
 */
export function useIsPhone(): boolean {
  return React.useSyncExternalStore(subscribe, () => media()?.matches ?? false, () => false);
}
