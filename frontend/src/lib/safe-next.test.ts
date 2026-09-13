import { describe, expect, it } from "vitest";
import { DEFAULT_NEXT, isSafeNextPath, loginUrlFor, safeNext } from "@/lib/safe-next";

describe("isSafeNextPath", () => {
  it("accepts same-origin relative paths", () => {
    expect(isSafeNextPath("/")).toBe(true);
    expect(isSafeNextPath("/dashboard")).toBe(true);
    expect(isSafeNextPath("/settings/members?tab=pending#top")).toBe(true);
    expect(isSafeNextPath("/invitations/accept?token=abc-123")).toBe(true);
  });

  it("rejects protocol-relative and absolute URLs", () => {
    expect(isSafeNextPath("//evil.example")).toBe(false);
    expect(isSafeNextPath("///evil.example")).toBe(false);
    expect(isSafeNextPath("http://evil.example")).toBe(false);
    expect(isSafeNextPath("https://evil.example/")).toBe(false);
    expect(isSafeNextPath("javascript:alert(1)")).toBe(false);
    expect(isSafeNextPath("/http://evil.example")).toBe(false);
  });

  it("rejects backslashes and control characters", () => {
    expect(isSafeNextPath("/\\evil.example")).toBe(false);
    expect(isSafeNextPath("/dash\\board")).toBe(false);
    expect(isSafeNextPath("/dash\nboard")).toBe(false);
    expect(isSafeNextPath("/dash board")).toBe(false);
    expect(isSafeNextPath("/%2f%2fevil")).toBe(false);
  });

  it("rejects non-strings, empties and relative segments", () => {
    expect(isSafeNextPath(undefined)).toBe(false);
    expect(isSafeNextPath(null)).toBe(false);
    expect(isSafeNextPath(42)).toBe(false);
    expect(isSafeNextPath("")).toBe(false);
    expect(isSafeNextPath("dashboard")).toBe(false);
    expect(isSafeNextPath("../dashboard")).toBe(false);
  });
});

describe("safeNext", () => {
  it("returns the path when safe", () => {
    expect(safeNext("/settings/teams")).toBe("/settings/teams");
  });

  it("falls back for unsafe values", () => {
    expect(safeNext("//evil.example")).toBe(DEFAULT_NEXT);
    expect(safeNext(undefined)).toBe(DEFAULT_NEXT);
    expect(safeNext("//evil.example", "/x")).toBe("/x");
  });

  it("never redirects back into the auth pages", () => {
    expect(safeNext("/login")).toBe(DEFAULT_NEXT);
    expect(safeNext("/login?next=/dashboard")).toBe(DEFAULT_NEXT);
    expect(safeNext("/signup")).toBe(DEFAULT_NEXT);
    expect(safeNext("/loginish")).toBe("/loginish");
  });
});

describe("loginUrlFor", () => {
  it("encodes the current path into next", () => {
    expect(loginUrlFor("/settings/members?tab=pending")).toBe("/login?next=%2Fsettings%2Fmembers%3Ftab%3Dpending");
  });

  it("omits next for unsafe or auth paths", () => {
    expect(loginUrlFor("//evil")).toBe("/login");
    expect(loginUrlFor("/login")).toBe("/login");
  });
});
