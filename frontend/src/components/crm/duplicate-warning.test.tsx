import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyDuplicateCheck, ContactDuplicateCheck, DUPLICATE_DEBOUNCE_MS, DuplicateWarning } from "@/components/crm/duplicate-warning";

vi.mock("@/lib/api/crm", () => ({
  findContactDuplicates: vi.fn(),
  findCompanyDuplicates: vi.fn(),
}));

import { findCompanyDuplicates, findContactDuplicates } from "@/lib/api/crm";

describe("DuplicateWarning", () => {
  it("renders nothing without hits", () => {
    const { container } = render(<DuplicateWarning hits={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each hit with an Open link", () => {
    render(<DuplicateWarning hits={[{ id: "c9", name: "Ada Lovelace", detail: "ada@example.com", href: "/contacts/c9" }]} />);
    expect(screen.getByRole("status")).toHaveTextContent("Possible duplicate: Ada Lovelace (ada@example.com)");
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/contacts/c9");
  });
});

describe("ContactDuplicateCheck", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(findContactDuplicates).mockReset();
    vi.mocked(findCompanyDuplicates).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("looks up duplicates after the debounce and renders the warning", async () => {
    vi.mocked(findContactDuplicates).mockResolvedValue({
      results: [{ id: "c9", display_name: "Ada Lovelace", email: "ada@example.com", phone: "", company: null, matched_on: ["email"] }],
    });
    // Mounted empty like the create form, then the user types an email.
    const view = render(<ContactDuplicateCheck firstName="" lastName="" email="" phone="" />);
    view.rerender(<ContactDuplicateCheck firstName="" lastName="" email="ada@example.com" phone="" />);

    // Nothing fires immediately; the request waits for the debounce window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DUPLICATE_DEBOUNCE_MS - 50);
    });
    expect(findContactDuplicates).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(findContactDuplicates).toHaveBeenCalledTimes(1);
    expect(findContactDuplicates).toHaveBeenCalledWith(
      { email: "ada@example.com", phone: undefined, first_name: undefined, last_name: undefined, exclude: undefined },
      expect.any(AbortSignal),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Possible duplicate: Ada Lovelace (ada@example.com)");
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute("href", "/contacts/c9");
  });

  it("stays silent while disabled and when the input is too short", async () => {
    render(<ContactDuplicateCheck firstName="Ada" lastName="" email="" phone="" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DUPLICATE_DEBOUNCE_MS + 50);
    });
    expect(findContactDuplicates).not.toHaveBeenCalled();

    render(<ContactDuplicateCheck firstName="" lastName="" email="ada@example.com" phone="" enabled={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DUPLICATE_DEBOUNCE_MS + 50);
    });
    expect(findContactDuplicates).not.toHaveBeenCalled();
  });

  it("passes exclude for the record being edited and swallows lookup errors", async () => {
    vi.mocked(findCompanyDuplicates).mockRejectedValue(new Error("boom"));
    render(<CompanyDuplicateCheck name="Acme" website="" exclude="co1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DUPLICATE_DEBOUNCE_MS + 50);
    });
    expect(findCompanyDuplicates).toHaveBeenCalledWith({ name: "Acme", website: undefined, exclude: "co1" }, expect.any(AbortSignal));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
