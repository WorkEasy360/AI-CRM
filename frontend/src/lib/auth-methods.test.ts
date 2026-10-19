import { describe, expect, it } from "vitest";
import { ssoErrorMessage, WORKEASY360_SIGN_OUT_URL, workeasy360StartUrl } from "@/lib/auth-methods";

describe("Workeasy360 sign-in URLs", () => {
  it("starts a sign-in with a validated next path only", () => {
    expect(workeasy360StartUrl()).toBe("/api/auth/workeasy360/start");
    expect(workeasy360StartUrl("/contacts")).toBe("/api/auth/workeasy360/start?next=%2Fcontacts");
    expect(workeasy360StartUrl("https://evil.example/x")).toBe("/api/auth/workeasy360/start");
  });

  it("asks for a fresh Workeasy360 sign-in to confirm it's you", () => {
    expect(workeasy360StartUrl("/settings/security", { reauth: true })).toBe(
      "/api/auth/workeasy360/start?next=%2Fsettings%2Fsecurity&reauth=1",
    );
    expect(workeasy360StartUrl(null, { reauth: true })).toBe("/api/auth/workeasy360/start?reauth=1");
  });

  it("signs out of Workeasy360 through the server, and explains a failed confirmation", () => {
    expect(WORKEASY360_SIGN_OUT_URL).toBe("/api/auth/workeasy360/logout");
    expect(ssoErrorMessage("reauthentication_failed")).toMatch(/did not confirm it's you/);
    expect(ssoErrorMessage("reauthentication_wrong_account")).toMatch(/different Workeasy360 account/);
  });
});
