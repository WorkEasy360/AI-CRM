import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SheetView } from "@/components/views/sheet-view";
import { canEditInline, parseCell } from "@/components/views/cells";
import { ToastProvider } from "@/components/ui/toast";
import type { FieldDescriptor, ModuleSchema, RowsResponse } from "@/lib/api/crm-types";

vi.mock("@/lib/api/crm", () => ({
  getModuleSchema: vi.fn(),
  getRecordRows: vi.fn(),
  saveRecordEdits: vi.fn(),
  listPipelines: vi.fn(),
}));

import { getModuleSchema, getRecordRows, saveRecordEdits } from "@/lib/api/crm";

function field(key: string, overrides: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return {
    key,
    label: key.replace(/_/g, " "),
    type: "text",
    editable: true,
    read_only: false,
    required: false,
    sortable: true,
    groupable: false,
    choices: [],
    lookup: null,
    custom: false,
    importable: true,
    currency_field: null,
    ...overrides,
  };
}

const schema: ModuleSchema = {
  entity_type: "contact",
  label: "Contact",
  label_plural: "Contacts",
  title_field: "display_name",
  counts_as_record: true,
  default_columns: ["first_name", "email", "job_title"],
  fields: [field("first_name"), field("email", { type: "email", editable: false, read_only: true }), field("job_title")],
};

function rows(n: number): RowsResponse {
  return {
    entity_type: "contact",
    offset: 0,
    limit: 100,
    total: n,
    exact: true,
    columns: schema.fields,
    rows: Array.from({ length: n }, (_, i) => ({
      id: `c${i}`,
      version: 1,
      title: `Person ${i}`,
      values: { first_name: `Person ${i}`, email: `p${i}@example.com`, job_title: "" },
    })),
  };
}

function renderSheet() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <SheetView entity="contact" filters={{}} columns={[]} onColumnsChange={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("SheetView", () => {
  beforeEach(() => {
    vi.mocked(getModuleSchema).mockResolvedValue(schema);
    vi.mocked(getRecordRows).mockResolvedValue(rows(3));
    vi.mocked(saveRecordEdits).mockReset();
  });

  it("loads a window of rows with the schema's columns and the total", async () => {
    renderSheet();
    expect(await screen.findByText("Person 0")).toBeInTheDocument();
    expect(screen.getByText("3 records")).toBeInTheDocument();
    expect(vi.mocked(getRecordRows).mock.calls[0]![1]).toMatchObject({ offset: 0, limit: 100, columns: "first_name,email,job_title" });
    expect(screen.getByRole("columnheader", { name: /email/ })).toHaveTextContent("read only");
  });

  it("pastes down a column, refuses read-only cells locally, saves in one batch and shows per-cell results", async () => {
    vi.mocked(saveRecordEdits).mockResolvedValue({
      entity_type: "contact",
      saved: 1,
      failed: 1,
      results: [
        { id: "c0", status: "saved", version: 2, values: { job_title: "CTO" }, errors: {} },
        { id: "c1", status: "conflict", version: 5, values: { job_title: "Theirs" }, errors: { _row: { code: "version_conflict", message: "Changed" } } },
      ],
    });
    renderSheet();
    await screen.findByText("Person 0");
    const grid = screen.getByRole("grid", { name: "Sheet" });
    // select job_title rows 0-1, paste one value: it fills the selection
    const cells = screen.getAllByRole("gridcell");
    fireEvent.mouseDown(cells[2]!); // row 0, job_title
    fireEvent.mouseDown(cells[5]!, { shiftKey: true }); // row 1, job_title
    fireEvent.paste(grid, { clipboardData: { getData: () => "CTO" } });
    expect(await screen.findByRole("button", { name: "Save 2 rows" })).toBeInTheDocument();

    // a paste onto the read-only email column is refused before it reaches the server
    fireEvent.mouseDown(cells[1]!);
    fireEvent.paste(grid, { clipboardData: { getData: () => "x@example.com" } });
    await waitFor(() => expect(cells[1]).toHaveAttribute("aria-invalid", "true"));

    await userEvent.click(screen.getByRole("button", { name: "Save 2 rows" }));
    await waitFor(() => expect(saveRecordEdits).toHaveBeenCalledTimes(1));
    expect(vi.mocked(saveRecordEdits).mock.calls[0]![1]).toEqual([
      { id: "c0", version: 1, values: { job_title: "CTO" } },
      { id: "c1", version: 1, values: { job_title: "CTO" } },
    ]);
    // the conflicting row now shows the other person's value, and says the edit was not saved
    expect(await screen.findByText("Theirs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Edit not saved/ })).toBeInTheDocument();
    expect(within(grid).getAllByRole("row").length).toBeGreaterThan(1);
  });
});

describe("cell parsing", () => {
  it("parses by type and refuses what the server would", () => {
    expect(parseCell(field("amount", { type: "money" }), "1,250.50")).toEqual({ ok: true, value: "1250.50" });
    expect(parseCell(field("n", { type: "integer" }), "1.5").ok).toBe(false);
    expect(parseCell(field("d", { type: "date" }), "05/01/2026")).toEqual({ ok: true, value: "2026-01-05" });
    expect(parseCell(field("c", { type: "choice", choices: ["lead", "customer"] }), "Customer")).toEqual({ ok: true, value: "customer" });
    expect(parseCell(field("c", { type: "choice", choices: ["lead"] }), "nope").ok).toBe(false);
    expect(parseCell(field("b", { type: "boolean" }), "yes")).toEqual({ ok: true, value: true });
    expect(parseCell(field("name", { required: true }), "  ").ok).toBe(false);
    expect(canEditInline(field("x", { read_only: true }))).toBe(false);
    expect(canEditInline(field("owner", { type: "user" }))).toBe(false);
  });
});
