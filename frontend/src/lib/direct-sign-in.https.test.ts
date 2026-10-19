/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://crm.example.test/pipeline" }
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SIGNED_OUT_COOKIE,
  SIGNED_OUT_HOST_COOKIE,
  clearSignedOutMarker,
  hasSignedOutMarker,
  markSignedOut,
} from "@/lib/direct-sign-in";

// The same module on an https origin, where the marker is named like the CSRF cookie: `__Host-` prefixed.
describe("signed-out marker over https", () => {
  beforeEach(clearSignedOutMarker);
  afterEach(() => {
    clearSignedOutMarker();
    vi.restoreAllMocks();
  });

  it("runs on an https origin", () => {
    expect(window.location.protocol).toBe("https:");
  });

  it("is written as a __Host- cookie: Secure, Path=/, no Domain, no expiry", () => {
    const set = vi.spyOn(document, "cookie", "set");
    markSignedOut();
    const written = String(set.mock.calls[0]?.[0]);
    expect(written).toBe(`${SIGNED_OUT_HOST_COOKIE}=1; Path=/; SameSite=Lax; Secure`);
    expect(written).not.toMatch(/Domain|Max-Age|Expires/i);
    expect(SIGNED_OUT_HOST_COOKIE).toBe("__Host-keel_signed_out");
    // The browser (here, the jar) accepted it and hands it back, under that name only.
    expect(document.cookie).toContain(`${SIGNED_OUT_HOST_COOKIE}=1`);
    expect(document.cookie).not.toMatch(new RegExp(`(^|; )${SIGNED_OUT_COOKIE}=`));
    expect(hasSignedOutMarker()).toBe(true);
  });

  it("is removed again under that name", () => {
    markSignedOut();
    clearSignedOutMarker();
    expect(document.cookie).not.toContain("keel_signed_out");
    expect(hasSignedOutMarker()).toBe(false);
  });

  it("is also removed when it sits under the plain name (a leftover from before, or planted)", () => {
    document.cookie = `${SIGNED_OUT_COOKIE}=1; Path=/; SameSite=Lax; Secure`;
    expect(hasSignedOutMarker()).toBe(true);
    clearSignedOutMarker();
    expect(document.cookie).not.toContain("keel_signed_out");
  });

  it("is not hidden by a look-alike of the plain name listed before it (a sibling subdomain's cookie)", () => {
    document.cookie = `${SIGNED_OUT_COOKIE}=0; Path=/; SameSite=Lax; Secure`;
    markSignedOut();
    expect(document.cookie).toMatch(new RegExp(`${SIGNED_OUT_COOKIE}=0`));
    expect(hasSignedOutMarker()).toBe(true);
    const get = vi.spyOn(document, "cookie", "get");
    get.mockReturnValue(`${SIGNED_OUT_COOKIE}=0; ${SIGNED_OUT_HOST_COOKIE}=0; ${SIGNED_OUT_HOST_COOKIE}=1`);
    expect(hasSignedOutMarker()).toBe(true);
  });
});
