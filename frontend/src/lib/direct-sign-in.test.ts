import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_START_STORAGE_KEY,
  AUTO_START_WINDOW_MS,
  SIGNED_OUT_COOKIE,
  claimAutoStart,
  clearAutoStartGuard,
  clearSignedOutMarker,
  hasSignedOutMarker,
  markSignedOut,
} from "@/lib/direct-sign-in";

function reset(): void {
  clearSignedOutMarker();
  window.sessionStorage.clear();
}

describe("signed-out marker over http", () => {
  beforeEach(reset);
  afterEach(() => {
    reset();
    vi.restoreAllMocks();
  });

  it("is a plain session cookie: readable here, no expiry, so every tab sees it until the browser closes", () => {
    expect(hasSignedOutMarker()).toBe(false);
    const set = vi.spyOn(document, "cookie", "set");
    markSignedOut();
    expect(hasSignedOutMarker()).toBe(true);
    expect(document.cookie).toContain(`${SIGNED_OUT_COOKIE}=1`);
    const written = String(set.mock.calls[0]?.[0]);
    expect(written).toMatch(/^keel_signed_out=1;/); // http cannot carry the Secure that __Host- needs
    expect(written).toMatch(/Path=\//);
    expect(written).toMatch(/SameSite=Lax/);
    expect(written).not.toMatch(/Secure|Max-Age|Expires/i);
  });

  it("is removed by clearSignedOutMarker", () => {
    markSignedOut();
    clearSignedOutMarker();
    expect(hasSignedOutMarker()).toBe(false);
    expect(document.cookie).not.toContain(SIGNED_OUT_COOKIE);
  });

  it("is only the one value this code writes (a lookalike does not count)", () => {
    document.cookie = `${SIGNED_OUT_COOKIE}=0; Path=/`;
    expect(hasSignedOutMarker()).toBe(false);
  });

  it("is set if ANY cookie of that name has the value 1, not just the first one listed", () => {
    // document.cookie lists a cookie once per Domain/Path it was set with; a look-alike listed first
    // (say one a sibling subdomain planted) must not hide the real marker.
    const get = vi.spyOn(document, "cookie", "get");
    get.mockReturnValue(`theme=dark; ${SIGNED_OUT_COOKIE}=0; ${SIGNED_OUT_COOKIE}=1`);
    expect(hasSignedOutMarker()).toBe(true);
    get.mockReturnValue(`${SIGNED_OUT_COOKIE}=1; ${SIGNED_OUT_COOKIE}=0`);
    expect(hasSignedOutMarker()).toBe(true);
    get.mockReturnValue(`${SIGNED_OUT_COOKIE}=0; ${SIGNED_OUT_COOKIE}=; other=1`);
    expect(hasSignedOutMarker()).toBe(false);
    get.mockReturnValue(`x${SIGNED_OUT_COOKIE}=1; ${SIGNED_OUT_COOKIE}x=1; =1`);
    expect(hasSignedOutMarker()).toBe(false);
  });
});

describe("claimAutoStart", () => {
  beforeEach(reset);
  afterEach(() => {
    reset();
    vi.restoreAllMocks();
  });

  it("allows the first automatic start and remembers it", () => {
    expect(claimAutoStart(1_000_000)).toBe(true);
    expect(window.sessionStorage.getItem(AUTO_START_STORAGE_KEY)).toBe("1000000");
  });

  it("refuses while the signed-out marker is set, whatever else is true", () => {
    markSignedOut();
    expect(claimAutoStart(1_000_000)).toBe(false);
    expect(window.sessionStorage.getItem(AUTO_START_STORAGE_KEY)).toBeNull();
  });

  it("refuses a second start less than 60 seconds after the first (the loop guard)", () => {
    expect(claimAutoStart(1_000_000)).toBe(true);
    expect(claimAutoStart(1_000_000 + AUTO_START_WINDOW_MS - 1)).toBe(false);
    // The refused attempt does not extend the window.
    expect(window.sessionStorage.getItem(AUTO_START_STORAGE_KEY)).toBe("1000000");
  });

  it("allows another start once 60 seconds have passed", () => {
    expect(claimAutoStart(1_000_000)).toBe(true);
    expect(claimAutoStart(1_000_000 + AUTO_START_WINDOW_MS)).toBe(true);
    expect(window.sessionStorage.getItem(AUTO_START_STORAGE_KEY)).toBe(String(1_000_000 + AUTO_START_WINDOW_MS));
  });

  it("allows a start again as soon as a session has cleared the guard", () => {
    expect(claimAutoStart(1_000_000)).toBe(true);
    clearAutoStartGuard();
    expect(claimAutoStart(1_000_001)).toBe(true);
  });

  it("does not let a clock set back (a guard in the future) block sign-in until the clock catches up", () => {
    window.sessionStorage.setItem(AUTO_START_STORAGE_KEY, "9000000");
    expect(claimAutoStart(1_000_000)).toBe(true);
  });

  it("ignores garbage in the guard", () => {
    window.sessionStorage.setItem(AUTO_START_STORAGE_KEY, "not a number");
    expect(claimAutoStart(1_000_000)).toBe(true);
  });

  it("refuses to start anything it could not remember starting (storage blocked)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(claimAutoStart(1_000_000)).toBe(false);
  });

  it("refuses when storage cannot even be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(claimAutoStart(1_000_000)).toBe(false);
    expect(() => clearAutoStartGuard()).not.toThrow();
  });
});
