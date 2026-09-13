import { describe, expect, it } from "vitest";
import { ApiError, errorMessage, parseProblem } from "@/lib/api/problem";

describe("parseProblem", () => {
  it("passes RFC 9457 problem details through", () => {
    const problem = parseProblem(400, {
      type: "validation_error",
      title: "Validation failed",
      status: 400,
      detail: "Fix the errors below.",
      errors: [{ field: "email", code: "invalid", message: "Enter a valid email." }],
      request_id: "req-1",
    });
    expect(problem).toEqual({
      type: "validation_error",
      title: "Validation failed",
      status: 400,
      detail: "Fix the errors below.",
      errors: [{ field: "email", code: "invalid", message: "Enter a valid email." }],
      request_id: "req-1",
    });
  });

  it("strips a URI prefix from the type", () => {
    expect(parseProblem(403, { type: "https://keel.example/problems/reauth_required", title: "x", status: 403 }).type).toBe(
      "reauth_required",
    );
  });

  it("normalises allauth error envelopes", () => {
    const problem = parseProblem(400, {
      status: 400,
      errors: [{ message: "This password is too short.", code: "password_too_short", param: "password" }],
    });
    expect(problem.type).toBe("validation_error");
    expect(problem.status).toBe(400);
    expect(problem.errors).toEqual([{ field: "password", code: "password_too_short", message: "This password is too short." }]);
    expect(problem.detail).toBe("This password is too short.");
  });

  it("handles DRF-style {detail} bodies", () => {
    const problem = parseProblem(401, { detail: "Authentication credentials were not provided." });
    expect(problem.type).toBe("not_authenticated");
    expect(problem.detail).toBe("Authentication credentials were not provided.");
  });

  it("falls back to a generic problem for empty or non-JSON bodies", () => {
    expect(parseProblem(502, undefined)).toEqual({ type: "about:blank", title: "Something went wrong", status: 502 });
    expect(parseProblem(404, "not found")).toMatchObject({ status: 404, title: "Not found" });
    expect(parseProblem(401, null).type).toBe("not_authenticated");
  });
});

describe("ApiError", () => {
  it("classifies reauth_required", () => {
    const err = new ApiError({ type: "reauth_required", title: "Re-authentication required", status: 403 });
    expect(err.isReauthRequired).toBe(true);
    expect(err.isNotAuthenticated).toBe(false);
  });

  it("classifies not_authenticated on 401 and 403", () => {
    expect(new ApiError({ type: "not_authenticated", title: "x", status: 401 }).isNotAuthenticated).toBe(true);
    expect(new ApiError({ type: "not_authenticated", title: "x", status: 403 }).isNotAuthenticated).toBe(true);
    expect(new ApiError({ type: "permission_denied", title: "x", status: 403 }).isNotAuthenticated).toBe(false);
  });

  it("exposes field errors and a summary", () => {
    const err = new ApiError({
      type: "validation_error",
      title: "Validation failed",
      status: 400,
      errors: [
        { field: "email", code: "invalid", message: "Bad email" },
        { field: "email", code: "taken", message: "Already used" },
        { field: "role", code: "invalid", message: "Unknown role" },
      ],
    });
    expect(err.isValidation).toBe(true);
    expect(err.fieldErrors()).toEqual({ email: "Bad email", role: "Unknown role" });
    expect(err.summary()).toBe("email: Bad email");
    expect(errorMessage(err)).toBe("email: Bad email");
  });

  it("errorMessage falls back for unknown values", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("nope", "fallback")).toBe("fallback");
  });
});
