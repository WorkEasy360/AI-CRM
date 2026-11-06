import * as React from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { reportPlanBoundary, UpgradePromptHost } from "@/components/billing/upgrade-prompt";
import { ApiError, parseProblem } from "@/lib/api/problem";

describe("UpgradePromptHost", () => {
  it("opens with the edition that lifts the block", async () => {
    render(<UpgradePromptHost />);
    const error = new ApiError(
      parseProblem(403, {
        type: "feature_not_in_plan",
        status: 403,
        detail: "AI suite is not included in your Express plan.",
        upgrade: { kind: "feature", feature: "ai_suite", required_edition: { key: "premier", name: "Premier" }, url: "/settings/billing" },
      }),
    );
    act(() => reportPlanBoundary(error));
    expect(await screen.findByRole("heading", { name: "Upgrade to Premier" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Compare plans" })).toHaveAttribute("href", "/settings/billing");
  });

  it("stays closed for ordinary errors", () => {
    render(<UpgradePromptHost />);
    act(() => reportPlanBoundary(new ApiError(parseProblem(403, { type: "permission_denied", status: 403 }))));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
