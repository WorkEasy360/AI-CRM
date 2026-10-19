import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawResponse } from "@/lib/api/client";
import { clearSignedOutMarker, hasSignedOutMarker, markSignedOut } from "@/lib/direct-sign-in";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn<(path: string, options?: unknown) => Promise<RawResponse>>() }));
vi.mock("@/lib/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/client")>()),
  request: requestMock,
}));

import { login, logout, mfaAuthenticate } from "@/lib/api/allauth";

const respond = (status: number, json: unknown = undefined): RawResponse => ({
  status,
  ok: status >= 200 && status < 300,
  json,
  headers: new Headers(),
});

describe("signed-out marker and the allauth calls", () => {
  beforeEach(() => {
    requestMock.mockReset();
    clearSignedOutMarker();
  });
  afterEach(clearSignedOutMarker);

  it("a sign-out leaves the marker (it is what stops an automatic Workeasy360 sign-in afterwards)", async () => {
    requestMock.mockResolvedValue(respond(200));
    await logout();
    expect(requestMock).toHaveBeenCalledWith("/_allauth/browser/v1/auth/session", { method: "DELETE" });
    expect(hasSignedOutMarker()).toBe(true);
  });

  it("the marker is already there while the request is in flight, so no tab can see the session gone without it", async () => {
    let markerDuringRequest = false;
    requestMock.mockImplementation(async () => {
      markerDuringRequest = hasSignedOutMarker();
      return respond(200);
    });
    await logout();
    expect(markerDuringRequest).toBe(true);
  });

  it("allauth answering 401 (the session was already gone) still counts as signed out", async () => {
    requestMock.mockResolvedValue(respond(401));
    await logout();
    expect(hasSignedOutMarker()).toBe(true);
  });

  it.each([400, 403, 404, 429])(
    "takes the marker back when the server clearly refused (%i): the person is still signed in",
    async (status) => {
      requestMock.mockResolvedValue(respond(status, { status }));
      await expect(logout()).rejects.toThrow();
      expect(hasSignedOutMarker()).toBe(false);
    },
  );

  it.each([500, 502, 503])(
    "keeps the marker when the outcome is unclear (%i): the session may already be gone",
    async (status) => {
      requestMock.mockResolvedValue(respond(status, { status }));
      await expect(logout()).rejects.toThrow();
      expect(hasSignedOutMarker()).toBe(true);
    },
  );

  it("keeps the marker when the request itself fails (the answer may simply have been lost)", async () => {
    requestMock.mockRejectedValue(new TypeError("network down"));
    await expect(logout()).rejects.toThrow("network down");
    expect(hasSignedOutMarker()).toBe(true);
  });

  it("a password sign-in clears it", async () => {
    markSignedOut();
    requestMock.mockResolvedValue(respond(200, { status: 200, meta: { is_authenticated: true } }));
    await login({ email: "ada@example.com", password: "x" });
    expect(hasSignedOutMarker()).toBe(false);
  });

  it("a second-factor sign-in clears it; a sign-in still waiting for the code does not", async () => {
    markSignedOut();
    requestMock.mockResolvedValue(respond(401, { status: 401, data: { flows: [{ id: "mfa_authenticate", is_pending: true }] } }));
    expect(await login({ email: "ada@example.com", password: "x" })).toEqual({ kind: "mfa_required" });
    expect(hasSignedOutMarker()).toBe(true);

    requestMock.mockResolvedValue(respond(200, { status: 200, meta: { is_authenticated: true } }));
    await mfaAuthenticate("123456");
    expect(hasSignedOutMarker()).toBe(false);
  });

  it("a refused sign-in leaves it", async () => {
    markSignedOut();
    requestMock.mockResolvedValue(respond(400, { status: 400, errors: [{ message: "No.", code: "email_password_mismatch" }] }));
    await expect(login({ email: "ada@example.com", password: "wrong" })).rejects.toThrow();
    expect(hasSignedOutMarker()).toBe(true);
  });
});
