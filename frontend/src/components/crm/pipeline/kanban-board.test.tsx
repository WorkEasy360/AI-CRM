import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KanbanBoard } from "@/components/crm/pipeline/kanban-board";
import { CONFLICT_TITLE } from "@/components/crm/deals/move-stage-dialog";
import { ToastProvider } from "@/components/ui/toast";
import type { Board, Deal } from "@/lib/api/crm-types";
import { ApiError } from "@/lib/api/problem";

vi.mock("@/lib/api/crm", () => ({
  moveDealStage: vi.fn(),
  listTags: vi.fn(),
  setRecordTags: vi.fn(),
}));

import { moveDealStage } from "@/lib/api/crm";

function deal(overrides: Partial<Deal> & Pick<Deal, "id" | "name" | "stage">): Deal {
  return {
    owner: { id: "m1", display_name: "Ada Lovelace" },
    tags: [],
    custom_data: {},
    version: 3,
    archived_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    pipeline: { id: "p1", name: "Sales" },
    company: { id: "c1", name: "Acme" },
    primary_contact: null,
    amount: "1500.00",
    currency: "USD",
    exchange_rate: "1",
    amount_base: "1500.00",
    probability: 20,
    expected_close_date: "2026-10-01",
    status: "open",
    closed_at: null,
    lost_reason: "",
    stage_entered_at: "2026-01-02T00:00:00Z",
    description: "",
    line_count: 0,
    products_total: null,
    ...overrides,
  };
}

const stageBase = { pipeline_id: "p1", description: "", archived_at: null, has_more: false };

const board: Board = {
  pipeline: { id: "p1", name: "Sales" },
  stages: [
    {
      ...stageBase,
      id: "s1",
      name: "Qualified",
      position: 1,
      kind: "open",
      default_probability: 20,
      color_token: "blue",
      deal_count: 2,
      total_amount_base: "4000.00",
      deals: [deal({ id: "d1", name: "Acme renewal", stage: { id: "s1", name: "Qualified", kind: "open", color_token: "blue" } }), deal({ id: "d2", name: "Globex pilot", stage: { id: "s1", name: "Qualified", kind: "open", color_token: "blue" }, amount: "2500.00", amount_base: "2500.00" })],
    },
    { ...stageBase, id: "s2", name: "Proposal", position: 2, kind: "open", default_probability: 50, color_token: "teal", deal_count: 0, total_amount_base: "0.00", deals: [] },
    { ...stageBase, id: "s3", name: "Won", position: 3, kind: "won", default_probability: 100, color_token: "green", deal_count: 0, total_amount_base: "0.00", deals: [] },
    { ...stageBase, id: "s4", name: "Lost", position: 4, kind: "lost", default_probability: 0, color_token: "red", deal_count: 0, total_amount_base: "0.00", deals: [] },
  ],
};

function renderBoard(props: Partial<React.ComponentProps<typeof KanbanBoard>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <KanbanBoard board={board} baseCurrency="USD" {...props} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("KanbanBoard", () => {
  beforeAll(() => {
    // Radix menus rely on pointer-capture and scrollIntoView, which jsdom does not implement.
    Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false);
    Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {});
    Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
  });

  beforeEach(() => {
    vi.mocked(moveDealStage).mockReset();
  });

  it("renders one column per stage with counts, totals and deal cards", () => {
    renderBoard();

    const columns = screen.getAllByRole("listitem").filter((el) => el.getAttribute("data-testid")?.startsWith("column-"));
    expect(columns).toHaveLength(4);
    expect(screen.getByRole("heading", { name: "Qualified" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Lost" })).toBeInTheDocument();
    expect(screen.getByLabelText("2 deals")).toBeInTheDocument();
    expect(screen.getByText("$4,000.00")).toBeInTheDocument();

    const card = screen.getByTestId("deal-card-d1");
    expect(within(card).getByRole("link", { name: "Acme renewal" })).toHaveAttribute("href", "/deals/d1");
    expect(within(card).getByText("Acme")).toBeInTheDocument();
    expect(within(card).getByText("$1,500.00")).toBeInTheDocument();
    expect(card).toHaveAttribute("draggable", "true");
  });

  it("hides drag and move controls when the user cannot change stages", () => {
    renderBoard({ canMove: false });
    expect(screen.getByTestId("deal-card-d1")).toHaveAttribute("draggable", "false");
    expect(screen.queryByRole("button", { name: /Move Acme renewal/ })).not.toBeInTheDocument();
  });

  it("moves a deal through the Move to… menu with the deal version and target stage", async () => {
    const user = userEvent.setup();
    vi.mocked(moveDealStage).mockImplementation(async (id, version, stage_id) =>
      deal({ id, name: "Acme renewal", version: version + 1, stage: { id: stage_id, name: "Proposal", kind: "open", color_token: "teal" } }),
    );
    renderBoard();

    await user.click(screen.getByRole("button", { name: "Move Acme renewal to another stage" }));
    await user.click(await screen.findByRole("menuitem", { name: "Proposal" }));

    await waitFor(() => expect(moveDealStage).toHaveBeenCalledWith("d1", 3, "s2", undefined));
    // Optimistic move: the card now sits in the Proposal column.
    const proposal = screen.getByTestId("column-s2");
    await waitFor(() => expect(within(proposal).getByTestId("deal-card-d1")).toBeInTheDocument());
  });

  it("asks for a lost reason before moving into a lost stage", async () => {
    const user = userEvent.setup();
    vi.mocked(moveDealStage).mockImplementation(async (id, version, stage_id, lost_reason) =>
      deal({ id, name: "Acme renewal", version: version + 1, status: "lost", lost_reason: lost_reason ?? "", stage: { id: stage_id, name: "Lost", kind: "lost", color_token: "red" } }),
    );
    renderBoard();

    await user.click(screen.getByRole("button", { name: "Move Acme renewal to another stage" }));
    await user.click(await screen.findByRole("menuitem", { name: /^Lost/ }));

    const dialog = await screen.findByRole("dialog", { name: "Mark as lost?" });
    expect(moveDealStage).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText("Lost reason (optional)"), "Budget cut");
    await user.click(within(dialog).getByRole("button", { name: "Mark as lost" }));

    await waitFor(() => expect(moveDealStage).toHaveBeenCalledWith("d1", 3, "s4", "Budget cut"));
  });

  it("reverts the card and explains a version conflict", async () => {
    const user = userEvent.setup();
    vi.mocked(moveDealStage).mockRejectedValue(new ApiError({ type: "version_conflict", title: "Conflict", status: 409, detail: "The deal was modified." }));
    renderBoard();

    await user.click(screen.getByRole("button", { name: "Move Acme renewal to another stage" }));
    await user.click(await screen.findByRole("menuitem", { name: "Proposal" }));

    expect(await screen.findByText(CONFLICT_TITLE)).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByTestId("column-s1")).getByTestId("deal-card-d1")).toBeInTheDocument());
    expect(within(screen.getByTestId("column-s2")).queryByTestId("deal-card-d1")).not.toBeInTheDocument();
  });
});
