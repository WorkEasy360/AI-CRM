import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DataPage } from "@/components/settings/data-page";
import { ToastProvider } from "@/components/ui/toast";
import type { ImportJob } from "@/lib/api/crm-types";
import type { Session } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({
  uploadImport: vi.fn(),
  listImports: vi.fn(),
  getImport: vi.fn(),
  checkImport: vi.fn(),
  startImport: vi.fn(),
  rollbackImport: vi.fn(),
  suggestImportMapping: vi.fn(),
  createExport: vi.fn(),
  listExports: vi.fn(),
  exportDownloadUrl: vi.fn(() => "#"),
}));

vi.mock("@/components/reauth-provider", () => ({
  useReauth: () => ({ runSensitive: <T,>(op: () => Promise<T>) => op() }),
  isReauthCancelled: () => false,
}));

const SESSION = { active: { membership_id: "m1", permissions: { "contacts.import": "all" } } } as unknown as Session;

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: SESSION }) };
});

import { checkImport, getImport, listImports, rollbackImport, startImport, uploadImport } from "@/lib/api/crm";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

function job(overrides: Partial<ImportJob> = {}): ImportJob {
  return {
    id: "j1",
    entity_type: "contact",
    status: "uploaded",
    original_filename: "people.csv",
    size_bytes: 2048,
    headers: ["Name", "Email"],
    mapping: { Name: "first_name", Email: "email" },
    options: {},
    file_format: "csv",
    total_rows: 10,
    processed_rows: 0,
    created_rows: 0,
    updated_rows: 0,
    skipped_rows: 0,
    error_rows: 0,
    errors: [],
    error_message: "",
    preview: {},
    stop: {},
    rollback: {},
    rolled_back_at: null,
    requested_by: null,
    started_at: null,
    finished_at: null,
    created_at: "2026-10-01T10:00:00Z",
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <DataPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const page = (results: ImportJob[]) => ({ next: null, previous: null, results });

describe("DataPage imports", () => {
  beforeEach(() => {
    vi.mocked(uploadImport).mockReset();
    vi.mocked(listImports).mockReset().mockResolvedValue(page([]));
    vi.mocked(getImport).mockReset();
    vi.mocked(checkImport).mockReset();
    vi.mocked(startImport).mockReset();
    vi.mocked(rollbackImport).mockReset();
  });

  it("checks the file, shows the dry run and the plan limit, then imports", async () => {
    const user = userEvent.setup();
    vi.mocked(uploadImport).mockResolvedValue(
      job({
        sample: [{ Name: "Ada", Email: "ada@example.com" }],
        targets: { first_name: "First name", email: "Email" },
        presets: [{ key: "hubspot", label: "HubSpot", mapping: {} }],
      }),
    );
    vi.mocked(checkImport).mockResolvedValue(job({ status: "previewing" }));
    vi.mocked(getImport).mockResolvedValue(
      job({
        status: "previewed",
        preview: {
          rows_checked: 10,
          would_create: 6,
          would_update: 2,
          would_skip: 1,
          would_fail: 1,
          companies_to_create: 0,
          errors: [{ row: 4, errors: [{ field: "email", message: "Enter a valid email address." }] }],
          limit: { stops_at_row: 7, capacity: 5, message: "", upgrade: { required_edition: { key: "premier", name: "Premier" } } },
        },
      }),
    );
    vi.mocked(startImport).mockResolvedValue(job({ status: "pending" }));
    renderPage();

    await user.upload(screen.getByLabelText(/choose file/i), new File(["Name,Email\nAda,ada@example.com"], "people.csv", { type: "text/csv" }));
    await user.click(screen.getByRole("button", { name: /upload and map columns/i }));

    expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByLabelText("Mapping preset")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check file" }));

    await waitFor(() =>
      expect(checkImport).toHaveBeenCalledWith("contacts", "j1", { Name: "first_name", Email: "email" }, { dedupe: "create", create_companies: true }),
    );
    expect(await screen.findByText("Your plan has room for 5 more records; the import would stop at row 7.")).toBeInTheDocument();
    expect(screen.getByText(/Upgrade to Premier/)).toBeInTheDocument();
    expect(screen.getByText("Will create").nextSibling).toHaveTextContent("6");
    expect(screen.getByText("Will update").nextSibling).toHaveTextContent("2");
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(startImport).toHaveBeenCalledWith("contacts", "j1"));
  });

  it("shows a job that stopped at the plan limit with its upgrade path", async () => {
    vi.mocked(listImports).mockResolvedValue(
      page([
        job({
          status: "stopped",
          processed_rows: 6,
          created_rows: 5,
          updated_rows: 1,
          stop: { row: 7, message: "Your plan's record limit was reached.", upgrade: { required_edition: { key: "premier", name: "Premier" } } },
        }),
      ]),
    );
    renderPage();

    expect(await screen.findByText("Stopped at limit")).toBeInTheDocument();
    expect(screen.getByText(/Your plan's record limit was reached\. Upgrade to Premier to import the rest\./)).toBeInTheDocument();
    expect(screen.getByText("5 created · 1 updated")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /roll back/i })).toBeInTheDocument();
  });

  it("rolls back an import after confirmation and shows the summary with conflicts", async () => {
    const user = userEvent.setup();
    const done = job({ status: "completed", processed_rows: 10, created_rows: 3, updated_rows: 1 });
    vi.mocked(listImports).mockResolvedValue(page([done]));
    vi.mocked(rollbackImport).mockResolvedValue({ ...done, status: "rolling_back" });
    vi.mocked(getImport).mockResolvedValue({
      ...done,
      status: "rolled_back",
      rollback: {
        deleted: 2,
        reverted: 1,
        missing: 0,
        conflict_count: 1,
        conflicts: [{ row: 4, entity_type: "contact", entity_id: "c9", reason: "has_notes" }],
      },
    });
    renderPage();

    await user.click(await screen.findByRole("button", { name: /roll back/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/deletes the 3 records it created and restores the 1/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Roll back" }));

    await waitFor(() => expect(rollbackImport).toHaveBeenCalledWith("contacts", "j1"));
    const summary = await screen.findByLabelText("Rollback summary");
    await within(summary).findByText("Has notes");
    expect(within(summary).getByText("Deleted").nextSibling).toHaveTextContent("2");
    expect(within(summary).getByText("Restored").nextSibling).toHaveTextContent("1");
    expect(within(summary).getByRole("link", { name: "contact" })).toHaveAttribute("href", "/contacts/c9");
  });
});
