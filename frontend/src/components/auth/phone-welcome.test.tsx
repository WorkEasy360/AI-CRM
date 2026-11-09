import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PhoneWelcome } from "@/components/auth/phone-welcome";

let search = "";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(search) }));

const welcome = () => screen.queryByRole("region", { name: "Welcome to WorkEasy360 CRM" });

describe("PhoneWelcome", () => {
  it("offers Login and Create Account, and steps aside for the form", async () => {
    search = "";
    const user = userEvent.setup();
    render(<PhoneWelcome />);
    expect(screen.getByRole("link", { name: "Create Account" })).toHaveAttribute("href", "/signup");

    await user.click(screen.getByRole("button", { name: "Login to CRM" }));
    expect(welcome()).not.toBeInTheDocument();
  });

  it("still greets someone the app sent here to sign in", () => {
    search = "next=%2Fdashboard";
    render(<PhoneWelcome />);
    expect(welcome()).toBeInTheDocument();
  });

  it("never covers a message meant for the form", () => {
    search = "sso_error=denied";
    render(<PhoneWelcome />);
    expect(welcome()).not.toBeInTheDocument();
  });

  it("is switched off above phone width by CSS, so it never flashes on larger screens", () => {
    search = "";
    render(<PhoneWelcome />);
    expect(welcome()).toHaveClass("md:hidden");
  });
});
