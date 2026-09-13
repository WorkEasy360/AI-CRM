"use client";

import * as React from "react";

/**
 * Theme preference. The workspace is light by default; dark is an opt-in the user picks from the
 * account menu ("System" follows the OS setting). Stored per browser; nothing here is sent to the API.
 */
export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "keel.theme";
const EVENT = "keel:theme";

export function readThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "dark" || value === "system" ? value : "light";
  } catch {
    return "light";
  }
}

function resolve(preference: ThemePreference): "light" | "dark" {
  if (preference === "system") {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return preference;
}

export function applyTheme(preference: ThemePreference): void {
  document.documentElement.dataset.theme = resolve(preference);
}

export function writeThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    /* private mode or storage disabled: the choice lasts for this page only */
  }
  applyTheme(preference);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: preference }));
}

/** Current preference plus a setter; every mounted instance stays in sync. */
export function useTheme(): { preference: ThemePreference; setPreference: (next: ThemePreference) => void } {
  const [preference, setState] = React.useState<ThemePreference>("light");

  React.useEffect(() => {
    setState(readThemePreference());
    const onChange = (event: Event) => setState((event as CustomEvent<ThemePreference>).detail);
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);

  React.useEffect(() => {
    if (preference !== "system" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onMedia = () => applyTheme("system");
    media.addEventListener("change", onMedia);
    return () => media.removeEventListener("change", onMedia);
  }, [preference]);

  const setPreference = React.useCallback((next: ThemePreference) => {
    setState(next);
    writeThemePreference(next);
  }, []);

  return { preference, setPreference };
}

/** Mounts once at the root and applies the stored preference on first paint of the client. */
export function ThemeSync() {
  React.useEffect(() => {
    applyTheme(readThemePreference());
  }, []);
  return null;
}
