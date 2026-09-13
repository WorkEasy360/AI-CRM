import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LifecycleStatusChanger } from "@/components/crm/lifecycle-select";
import { ToastProvider } from "@/components/ui/toast";

vi.mock("@/lib/api/crm", () => ({
  updateContact: vi.fn(),
  updateCompany: vi.fn(),
}));

import { updateCompany, updateContact } from "@/lib/api/crm";

function renderChanger(props: Partial<React.ComponentProps<typeof LifecycleStatusChanger>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <LifecycleStatusChanger entity="contact" record={{ id: "c1", version: 4, lifecycle_stage: "lead" }} {...props} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("LifecycleStatusChanger", () => {
  beforeAll(() => {
    // Radix menus rely on pointer-capture and scrollIntoView, which jsdom does not implement.
    Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false);
    Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {});
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
  });

  beforeEach(() => {
    vi.mocked(updateContact).mockReset();
    vi.mocked(updateCompany).mockReset();
  });

  it("patches lifecycle_stage with the current version when a new status is picked", async () => {
    const user = userEvent.setup();
    vi.mocked(updateContact).mockResolvedValue({ id: "c1", version: 5, lifecycle_stage: "customer" } as never);
    renderChanger();

    await user.click(screen.getByRole("button", { name: /Status: Lead/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Customer" }));

    await waitFor(() => expect(updateContact).toHaveBeenCalledTimes(1));
    expect(updateContact).toHaveBeenCalledWith("c1", 4, { lifecycle_stage: "customer" });
    expect(await screen.findByText("Status updated")).toBeInTheDocument();
  });

  it("does nothing when the current status is re-selected", async () => {
    const user = userEvent.setup();
    renderChanger();

    await user.click(screen.getByRole("button", { name: /Status: Lead/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Lead" }));

    expect(updateContact).not.toHaveBeenCalled();
  });

  it("uses the company endpoint for companies", async () => {
    const user = userEvent.setup();
    vi.mocked(updateCompany).mockResolvedValue({ id: "co1", version: 2, lifecycle_stage: "prospect" } as never);
    renderChanger({ entity: "company", record: { id: "co1", version: 1, lifecycle_stage: "lead" } });

    await user.click(screen.getByRole("button", { name: /Status: Lead/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Prospect" }));

    await waitFor(() => expect(updateCompany).toHaveBeenCalledWith("co1", 1, { lifecycle_stage: "prospect" }));
  });

  it("renders a plain badge when disabled", () => {
    renderChanger({ disabled: true, record: { id: "c1", version: 1, lifecycle_stage: "qualified" } });
    expect(screen.getByText("Qualified")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
