import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FilesPanel } from "@/components/crm/files-panel";
import { ToastProvider } from "@/components/ui/toast";
import type { FileAttachment } from "@/lib/api/crm-types";
import type { RoleRef, Session } from "@/lib/api/types";

vi.mock("@/lib/api/crm", () => ({
  listFiles: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  fileDownloadUrl: (id: string) => `/api/v1/files/${id}/download/`,
}));

let permissions: Record<string, "own" | "team" | "all"> = {};
const session = (): Session => ({
  user: { id: "u1", email: "ada@example.com", display_name: "Ada" } as Session["user"],
  mfa_enabled: false,
  recently_authenticated: true,
  memberships: [],
  active: {
    membership_id: "m1",
    organization: { id: "o1", name: "Keel", slug: "keel", base_currency: "USD", timezone: "UTC", plan: "free", status: "active", require_mfa: false, created_at: "2026-01-01T00:00:00Z" },
    role: { key: "sales_rep", name: "Sales Rep" } as RoleRef,
    permissions,
    mfa_required: false,
  },
});

vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, useSession: () => ({ data: session() }) };
});

import { deleteFile, listFiles, uploadFile } from "@/lib/api/crm";

const mine: FileAttachment = {
  id: "f1",
  entity_type: "deal",
  entity_id: "d1",
  filename: "proposal.pdf",
  content_type: "application/pdf",
  size_bytes: 2048,
  uploaded_by: { id: "m1", display_name: "Ada" } as FileAttachment["uploaded_by"],
  created_at: "2026-09-14T09:00:00Z",
};
const theirs: FileAttachment = { ...mine, id: "f2", filename: "contract.pdf", uploaded_by: { id: "m2", display_name: "Hank" } as FileAttachment["uploaded_by"] };

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <FilesPanel entity="deal" recordId="d1" />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("FilesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    permissions = { "files.view": "all", "files.upload": "all", "files.delete": "own" };
    vi.mocked(listFiles).mockResolvedValue({ results: [mine, theirs] } as Awaited<ReturnType<typeof listFiles>>);
  });

  it("lists files with a download link and uploads the picked file", async () => {
    const user = userEvent.setup();
    vi.mocked(uploadFile).mockResolvedValue({ ...mine, id: "f3", filename: "deck.pdf" });
    renderPanel();

    expect(await screen.findByText("proposal.pdf")).toBeInTheDocument();
    expect(screen.getAllByText("2 KB")).toHaveLength(2);
    expect(screen.getByLabelText("Download proposal.pdf")).toHaveAttribute("href", "/api/v1/files/f1/download/");

    const file = new File(["hello"], "deck.pdf", { type: "application/pdf" });
    await user.upload(screen.getByLabelText("Upload a file"), file);
    await waitFor(() => expect(uploadFile).toHaveBeenCalledWith({ entity_type: "deal", entity_id: "d1", file }));
  });

  it("offers deletion only for the member's own uploads under an own scope", async () => {
    const user = userEvent.setup();
    vi.mocked(deleteFile).mockResolvedValue(undefined);
    renderPanel();

    expect(await screen.findByLabelText("Delete proposal.pdf")).toBeInTheDocument();
    expect(screen.queryByLabelText("Delete contract.pdf")).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("Delete proposal.pdf"));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteFile).toHaveBeenCalledWith("f1"));
  });

  it("hides the uploader without files.upload and rejects files over 10 MB", async () => {
    const user = userEvent.setup();
    permissions = { "files.view": "all" };
    renderPanel();

    expect(await screen.findByText("proposal.pdf")).toBeInTheDocument();
    expect(screen.queryByLabelText("Upload a file")).not.toBeInTheDocument();

    cleanup();
    permissions = { "files.view": "all", "files.upload": "all" };
    renderPanel();
    const big = new File(["x"], "huge.pdf", { type: "application/pdf" });
    Object.defineProperty(big, "size", { value: 11 * 1024 * 1024 });
    await user.upload(await screen.findByLabelText("Upload a file"), big);
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
