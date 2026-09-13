import { describe, expect, it } from "vitest";
import { getCsrfToken, readCookie } from "@/lib/csrf";

describe("readCookie", () => {
  it("returns the value of a named cookie", () => {
    expect(readCookie("a", "a=1; b=2")).toBe("1");
    expect(readCookie("b", "a=1; b=2")).toBe("2");
  });

  it("returns null when the cookie is missing or the jar is empty", () => {
    expect(readCookie("c", "a=1; b=2")).toBeNull();
    expect(readCookie("a", "")).toBeNull();
  });

  it("does not match cookies by prefix", () => {
    expect(readCookie("token", "tokenx=1; xtoken=2")).toBeNull();
  });

  it("decodes percent-encoded values", () => {
    expect(readCookie("a", "a=hello%20world")).toBe("hello world");
  });

  it("keeps '=' characters inside the value", () => {
    expect(readCookie("a", "a=abc==; b=2")).toBe("abc==");
  });
});

describe("getCsrfToken", () => {
  it("reads the dev cookie", () => {
    expect(getCsrfToken("keel_csrftoken=devtoken")).toBe("devtoken");
  });

  it("reads the production __Host- cookie", () => {
    expect(getCsrfToken("__Host-keel_csrftoken=prodtoken")).toBe("prodtoken");
  });

  it("prefers the __Host- cookie when both exist", () => {
    expect(getCsrfToken("keel_csrftoken=dev; __Host-keel_csrftoken=prod")).toBe("prod");
  });

  it("returns null when neither cookie is set", () => {
    expect(getCsrfToken("sessionid=abc")).toBeNull();
    expect(getCsrfToken("")).toBeNull();
  });

  it("reads document.cookie by default", () => {
    document.cookie = "keel_csrftoken=fromdoc";
    expect(getCsrfToken()).toBe("fromdoc");
    document.cookie = "keel_csrftoken=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  });
});
