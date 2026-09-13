import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CUSTOM_FIELD_KEY_MESSAGE, CUSTOM_FIELD_KEY_RE, CustomFieldDialog, keyFromLabel, parseOptions } from "@/components/settings/custom-fields-page";
import { ToastProvider } from "@/components/ui/toast";
import { ApiError, parseProblem } from "@/lib/api/problem";
import type { CustomFieldDefinition } from "@/lib/api/crm-types";

vi.mock("@/lib/api/crm", () => ({
  listCustomFields: vi.fn(),
  createCustomField: vi.fn(),
  updateCustomField: vi.fn(),
  archiveCustomField: vi.fn(),
  restoreCustomField: vi.fn(),
}));

import { createCustomField, updateCustomField } from "@/lib/api/crm";

// jsdom lacks ResizeObserver, which Radix Switch/Select use for sizing.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

function renderDialog(field: CustomFieldDefinition | "new" = "new") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <CustomFieldDialog entity="contact" field={field} onOpenChange={onOpenChange} />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

const existing: CustomFieldDefinition = {
  id: "f1",
  entity_type: "contact",
  key: "priority",
  label: "Priority",
  description: "",
  field_type: "dropdown",
  options: ["Low", "High"],
  is_required: false,
  position: 1,
  archived_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("custom field key rules", () => {
  it("matches the backend key pattern", () => {
    expect(CUSTOM_FIELD_KEY_RE.test("lead_score")).toBe(true);
    expect(CUSTOM_FIELD_KEY_RE.test("a")).toBe(true);
    expect(CUSTOM_FIELD_KEY_RE.test("1abc")).toBe(false);
    expect(CUSTOM_FIELD_KEY_RE.test("Lead")).toBe(false);
    expect(CUSTOM_FIELD_KEY_RE.test("lead-score")).toBe(false);
    expect(CUSTOM_FIELD_KEY_RE.test("a".repeat(41))).toBe(false);
    expect(CUSTOM_FIELD_KEY_RE.test("a".repeat(40))).toBe(true);
  });

  it("derives a key from a label", () => {
    expect(keyFromLabel("Lead Score!")).toBe("lead_score");
    expect(keyFromLabel("42 things")).toBe("things");
    expect(keyFromLabel("x".repeat(60))).toHaveLength(40);
  });

  it("parses options one per line", () => {
    expect(parseOptions(" Low \n\nHigh\r\n")).toEqual(["Low", "High"]);
  });
});

describe("CustomFieldDialog", () => {
  beforeEach(() => {
    vi.mocked(createCustomField).mockReset();
    vi.mocked(updateCustomField).mockReset();
  });

  it("suggests a key from the label and rejects an invalid key client-side", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Label"), "Lead Score");
    const key = screen.getByLabelText("Key");
    expect(key).toHaveValue("lead_score");

    await user.clear(key);
    await user.type(key, "1bad-key");
    await user.click(screen.getByRole("button", { name: "Create field" }));

    expect(await screen.findByText(CUSTOM_FIELD_KEY_MESSAGE)).toBeInTheDocument();
    expect(createCustomField).not.toHaveBeenCalled();
  });

  it("requires options for dropdown fields", async () => {
    const user = userEvent.setup();
    renderDialog({ ...existing, options: [] });

    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Add at least one option (one per line).")).toBeInTheDocument();
    expect(updateCustomField).not.toHaveBeenCalled();
  });

  it("maps a 409 conflict onto the key field", async () => {
    vi.mocked(createCustomField).mockRejectedValue(new ApiError(parseProblem(409, { type: "conflict", title: "Conflict", status: 409, detail: "exists" })));
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Label"), "Priority");
    await user.click(screen.getByRole("button", { name: "Create field" }));

    expect(await screen.findByText("A field with this key already exists for this record type.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Key")).toHaveAttribute("aria-invalid", "true"));
    expect(createCustomField).toHaveBeenCalledWith(expect.objectContaining({ entity_type: "contact", key: "priority", label: "Priority", field_type: "text" }));
  });

  it("maps server field errors onto their inputs", async () => {
    vi.mocked(createCustomField).mockRejectedValue(
      new ApiError(
        parseProblem(400, {
          type: "validation_error",
          title: "Invalid request",
          status: 400,
          errors: [
            { field: "key", code: "reserved", message: "This key collides with a built-in field." },
            { field: "entity_type", code: "invalid", message: "Unknown entity." },
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText("Label"), "Email");
    await user.click(screen.getByRole("button", { name: "Create field" }));

    expect(await screen.findByText("This key collides with a built-in field.")).toBeInTheDocument();
    expect(screen.getByText(/entity_type: Unknown entity\./)).toBeInTheDocument();
  });

  it("keeps key and type read-only when editing and only sends mutable fields", async () => {
    vi.mocked(updateCustomField).mockResolvedValue({ ...existing, label: "Priority level" });
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog(existing);

    expect(screen.getByLabelText("Key")).toHaveAttribute("readonly");
    expect(screen.getByRole("combobox", { name: "Type" })).toBeDisabled();

    const label = screen.getByLabelText("Label");
    await user.clear(label);
    await user.type(label, "Priority level");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(updateCustomField).toHaveBeenCalledTimes(1));
    expect(updateCustomField).toHaveBeenCalledWith("f1", { label: "Priority level", description: "", is_required: false, options: ["Low", "High"] });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
