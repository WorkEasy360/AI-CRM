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
    probability_overridden: false,
    weighted_amount_base: "300.00",
    last_activity_at: null,
    next_activity_at: null,
    next_activity_title: "",
    risk_level: "low",
    contact_count: 0,
    products_total: null,
    ...overrides,
  };
}

const stageBase = { pipeline_id: "p1", description: "", archived_at: null, has_more: false };
const qualified = { id: "s1", name: "Qualified", kind: "open", color_token: "blue" } as const;

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
      deals: [
        deal({ id: "d1", name: "Acme renewal", stage: qualified }),
        deal({
          id: "d2",
          name: "Globex pilot",
          stage: qualified,
          amount: "2500.00",
          amount_base: "2500.00",
          probability: 60,
          weighted_amount_base: "1500.00",
          next_activity_at: "2026-09-20T10:00:00Z",
          next_activity_title: "Call about pricing",
          risk_level: "high",
        }),
      ],
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

  it("renders one column per stage with counts, totals, weighted totals and deal cards", () => {
    renderBoard();

    const columns = screen.getAllByRole("listitem").filter((el) => el.getAttribute("data-testid")?.startsWith("column-"));
    expect(columns).toHaveLength(4);
    expect(screen.getByRole("heading", { name: "Qualified" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Lost" })).toBeInTheDocument();
    expect(screen.getByLabelText("2 deals")).toBeInTheDocument();
    expect(screen.getByText("$4,000.00")).toBeInTheDocument();
    // Weighted total sums the loaded cards (300 + 1500) since every card is loaded.
    expect(within(screen.getByTestId("column-s1")).getByText("Weighted $1,800.00")).toBeInTheDocument();
    expect(within(screen.getByTestId("column-s2")).queryByText(/Weighted/)).not.toBeInTheDocument();

    const card = screen.getByTestId("deal-card-d1");
    expect(within(card).getByRole("link", { name: "Acme renewal" })).toHaveAttribute("href", "/deals/d1");
    expect(within(card).getByText("Acme")).toBeInTheDocument();
    expect(within(card).getByText("$1,500.00")).toBeInTheDocument();
    expect(within(card).getByText("20%")).toBeInTheDocument();
    expect(within(card).getByText("No next step")).toBeInTheDocument();
    expect(within(card).getByRole("img", { name: "Low risk" })).toBeInTheDocument();
    expect(within(card).getByLabelText("Owner: Ada Lovelace")).toBeInTheDocument();
    expect(card).toHaveAttribute("draggable", "true");

    const other = screen.getByTestId("deal-card-d2");
    expect(within(other).getByText("60%")).toBeInTheDocument();
    expect(within(other).getByText("Call about pricing")).toBeInTheDocument();
    expect(within(other).getByRole("img", { name: "High risk" })).toBeInTheDocument();
  });

  it("omits the weighted total when a column is truncated and the risk dot without ai.scores.view", () => {
    const truncated: Board = { ...board, stages: board.stages.map((s) => (s.id === "s1" ? { ...s, has_more: true, deal_count: 5 } : s)) };
    renderBoard({ board: truncated, showRisk: false });
    expect(screen.queryByText(/Weighted/)).not.toBeInTheDocument();
    expect(screen.getByText("+3 more in the list view")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /risk/ })).not.toBeInTheDocument();
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
