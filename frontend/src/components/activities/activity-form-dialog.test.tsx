import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityFormDialog } from "@/components/activities/activity-form-dialog";
import { ToastProvider } from "@/components/ui/toast";
import type { ActivityInput } from "@/lib/api/crm-types";
import { ApiError } from "@/lib/api/problem";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({
  createActivity: vi.fn(),
  updateActivity: vi.fn(),
  getActivity: vi.fn(),
  listContacts: vi.fn(async () => ({ next: null, previous: null, results: [] })),
  listCompanies: vi.fn(async () => ({ next: null, previous: null, results: [] })),
  listDeals: vi.fn(async () => ({ next: null, previous: null, results: [] })),
}));

vi.mock("@/lib/api/endpoints", () => ({
  listMembers: vi.fn(async () => ({ next: null, previous: null, results: [] })),
  getSession: vi.fn(),
}));

const SESSION = {
  active: {
    membership_id: "m1",
    organization: { base_currency: "USD" },
    permissions: { "activities.create": "own", "activities.update": "own" },
  },
} as unknown as Session;

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: SESSION }) };
});

import { createActivity } from "@/lib/api/crm";

function renderDialog(props: Partial<React.ComponentProps<typeof ActivityFormDialog>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ActivityFormDialog open onOpenChange={() => {}} {...props} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

function payloadOf(call: unknown[] | undefined): ActivityInput {
  return (call?.[0] ?? {}) as ActivityInput;
}

// jsdom lacks ResizeObserver, which Radix Switch/Select use for sizing.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("ActivityFormDialog", () => {
  beforeAll(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    // Radix Select relies on pointer-capture and scrollIntoView, which jsdom does not implement.
    Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false);
    Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {});
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
  });

  beforeEach(() => {
    vi.mocked(createActivity).mockReset();
  });

  it("creates a task with a date-only due date as an all-day task", async () => {
    const user = userEvent.setup();
    vi.mocked(createActivity).mockResolvedValue({ id: "a1", kind: "task", title: "Send proposal", status: "open", contact: null, company: null, deal: null } as never);
    renderDialog({ kind: "task" });

    expect(screen.getByRole("dialog", { name: "New task" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Activity type" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Title"), "Send proposal");
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-09-15" } });
    await user.click(screen.getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(createActivity).toHaveBeenCalledTimes(1));
    const payload = payloadOf(vi.mocked(createActivity).mock.calls[0]);
    expect(payload).toMatchObject({
      kind: "task",
      title: "Send proposal",
      description: "",
      priority: "normal",
      all_day: true,
      contact_id: null,
      company_id: null,
      deal_id: null,
    });
    expect(payload).not.toHaveProperty("direction");
    expect(payload).not.toHaveProperty("owner_id");
    expect(payload).not.toHaveProperty("completed");
    // Local midnight on the chosen day, serialised with the browser's offset (never Z).
    expect(payload.start_at).toMatch(/[+-]\d{2}:\d{2}$/);
    expect(new Date(payload.start_at ?? "").getTime()).toBe(new Date(2026, 8, 15, 0, 0).getTime());
  });

  it("logs a call as completed with direction, outcome and the linked contact", async () => {
    const user = userEvent.setup();
    vi.mocked(createActivity).mockResolvedValue({ id: "a2", kind: "call", title: "Call with Ada", status: "completed", contact: { id: "c1", name: "Ada" }, company: null, deal: null } as never);
    renderDialog({ kind: "call", mode: "log", defaults: { contact: { id: "c1", name: "Ada Lovelace" } } });

    expect(screen.getByRole("dialog", { name: "Log call" })).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("Call with Ada Lovelace");
    expect(screen.getByLabelText("When")).not.toHaveValue("");
    // Reminder is a scheduling concern; logging hides it. The linked contact shows as a chip.
    expect(screen.queryByLabelText("Reminder")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Linked records")).toHaveTextContent("Ada Lovelace");

    fireEvent.change(screen.getByLabelText("When"), { target: { value: "2026-09-13T09:30" } });
    await user.click(screen.getByRole("combobox", { name: "Outcome" }));
    await user.click(await screen.findByRole("option", { name: "Connected" }));
    await user.type(screen.getByLabelText("Notes"), "Agreed to a demo next week");
    await user.click(screen.getByRole("button", { name: "Log call" }));

    await waitFor(() => expect(createActivity).toHaveBeenCalledTimes(1));
    const payload = payloadOf(vi.mocked(createActivity).mock.calls[0]);
    expect(payload).toMatchObject({
      kind: "call",
      title: "Call with Ada Lovelace",
      description: "Agreed to a demo next week",
      direction: "outbound",
      outcome: "connected",
      duration_minutes: 15,
      completed: true,
      contact_id: "c1",
    });
    expect(payload).not.toHaveProperty("reminder_minutes");
    expect(new Date(payload.start_at ?? "").getTime()).toBe(new Date(2026, 8, 13, 9, 30).getTime());
  });

  it("requires a title client-side and maps API field errors onto the form", async () => {
    const user = userEvent.setup();
    renderDialog({ kind: "meeting" });

    fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "" } });
    await user.click(screen.getByRole("button", { name: "Schedule meeting" }));
    expect(await screen.findByText("Enter a title.")).toBeInTheDocument();
    expect(await screen.findByText("Choose when the meeting starts.")).toBeInTheDocument();
    expect(createActivity).not.toHaveBeenCalled();

    vi.mocked(createActivity).mockRejectedValue(
      new ApiError({
        type: "validation_error",
        title: "Invalid request",
        status: 400,
        errors: [{ field: "start_at", code: "invalid", message: "Date out of range." }],
      }),
    );
    await user.type(screen.getByLabelText("Title"), "Kickoff");
    fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "2026-09-20T10:00" } });
    await user.click(screen.getByRole("button", { name: "Schedule meeting" }));

    expect(await screen.findByText("Date out of range.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Starts")).toHaveAttribute("aria-invalid", "true"));
    const payload = payloadOf(vi.mocked(createActivity).mock.calls[0]);
    // The end defaults to 30 minutes after the start; reminder defaults to 30 minutes before.
    expect(new Date(payload.end_at ?? "").getTime()).toBe(new Date(2026, 8, 20, 10, 30).getTime());
    expect(payload).toMatchObject({ kind: "meeting", all_day: false, reminder_minutes: 30, attendee_ids: [] });
  });
});
