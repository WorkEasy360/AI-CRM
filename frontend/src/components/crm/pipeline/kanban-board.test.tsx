import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppCallLink, WhatsAppChatLink } from "@/components/crm/contact-actions";
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
  amount_from_lines: false,
  price_book: null,
    ...overrides,
  };
}

const stageBase = { pipeline_id: "p1", description: "", archived_at: null, has_more: false };
const qualified = { id: "s1", name: "Qualified", kind: "open", color_token: "blue" } as const;

const board: Board = {
  pipeline: { id: "p1", name: "Sales", parent_id: null, layout: {} },
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
      weighted_amount_base: "1800.00",
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
    { ...stageBase, id: "s2", name: "Proposal", position: 2, kind: "open", default_probability: 50, color_token: "teal", deal_count: 0, total_amount_base: "0.00", weighted_amount_base: "0.00", deals: [] },
    { ...stageBase, id: "s3", name: "Won", position: 3, kind: "won", default_probability: 100, color_token: "green", deal_count: 0, total_amount_base: "0.00", weighted_amount_base: "0.00", deals: [] },
    { ...stageBase, id: "s4", name: "Lost", position: 4, kind: "lost", default_probability: 0, color_token: "red", deal_count: 0, total_amount_base: "0.00", weighted_amount_base: "0.00", deals: [] },
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
    // The weighted total is the server's figure for the whole column (300 + 1500 here).
    expect(within(screen.getByTestId("column-s1")).getByText("Weighted $1,800.00")).toBeInTheDocument();
    expect(within(screen.getByTestId("column-s2")).queryByText(/Weighted/)).not.toBeInTheDocument();

    const card = screen.getByTestId("deal-card-d1");
    expect(within(card).getByRole("link", { name: "Acme renewal" })).toHaveAttribute("href", "/deals/d1");
    expect(within(card).getByText("Acme")).toBeInTheDocument();
    expect(within(card).getByText("$1,500.00")).toBeInTheDocument();
    expect(within(card).getByTitle("20% probability")).toBeInTheDocument();
    expect(within(card).getByText("No next step")).toBeInTheDocument();
    expect(within(card).getByRole("img", { name: "Low risk" })).toBeInTheDocument();
    expect(within(card).getByLabelText("Owner: Ada Lovelace")).toBeInTheDocument();
    expect(card).toHaveAttribute("draggable", "true");

    const other = screen.getByTestId("deal-card-d2");
    expect(within(other).getByTitle("60% probability")).toBeInTheDocument();
    expect(within(other).getByText("Call about pricing")).toBeInTheDocument();
    expect(within(other).getByRole("img", { name: "High risk" })).toBeInTheDocument();
  });

  it("offers Call, WhatsApp and Follow-up on an open deal with a phone number", async () => {
    const withPhone: Board = {
      ...board,
      stages: board.stages.map((s) =>
        s.id === "s1" ? { ...s, deals: [deal({ id: "d9", name: "Phone deal", stage: qualified, primary_contact: { id: "c9", name: "Rahul Mehta", email: "", phone: "+91 98765-43210", whatsapp_opt_in: true } })] } : s,
      ),
    };
    renderBoard({ board: withPhone });
    const card = screen.getByTestId("deal-card-d9");
    expect(within(card).getByText("Rahul Mehta")).toBeInTheDocument();
    const chat = within(card).getByRole("link", { name: "WhatsApp Rahul Mehta" });
    expect(chat).toHaveAttribute("href", "https://wa.me/919876543210?text=Hi%20Rahul%2C%20regarding%20Phone%20deal");
    expect(chat).toHaveAttribute("target", "_blank");
    expect(chat).toHaveAttribute("rel", "noopener noreferrer");
    const call = within(card).getByRole("link", { name: "WhatsApp call Rahul Mehta" });
    expect(call).toHaveAttribute("href", "https://wa.me/919876543210");
    expect(call).toHaveAttribute("title", "WhatsApp call (opens chat)");
    expect(within(card).getByRole("button", { name: "Add a follow-up for Phone deal" })).toBeEnabled();

    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Move Phone deal to another stage" }));
    expect(await screen.findByRole("menuitem", { name: "Call via phone" })).toHaveAttribute("href", "tel:+919876543210");
  });

  it("leaves the WhatsApp composer closed, and a click on either link stays with the link", () => {
    const withPhone: Board = {
      ...board,
      stages: board.stages.map((s) =>
        s.id === "s1" ? { ...s, deals: [deal({ id: "d9", name: "Phone deal", stage: qualified, primary_contact: { id: "c9", name: "Rahul Mehta", email: "", phone: "8828731121", whatsapp_opt_in: true } })] } : s,
      ),
    };
    renderBoard({ board: withPhone });
    const card = screen.getByTestId("deal-card-d9");
    for (const name of ["WhatsApp Rahul Mehta", "WhatsApp call Rahul Mehta"]) {
      const link = within(card).getByRole("link", { name });
      expect(link).toHaveAttribute("draggable", "false");
      link.addEventListener("click", (event) => event.preventDefault());
      fireEvent.click(link);
    }
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    const onCardClick = vi.fn();
    render(
      <div onClick={onCardClick}>
        <WhatsAppChatLink number="918828731121" name="Isolated" />
        <WhatsAppCallLink number="918828731121" name="Isolated" />
      </div>,
    );
    for (const name of ["WhatsApp Isolated", "WhatsApp call Isolated"]) {
      const link = screen.getByRole("link", { name });
      link.addEventListener("click", (event) => event.preventDefault());
      fireEvent.click(link);
    }
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it("switches both off when the saved phone is not a usable number", () => {
    const badPhone: Board = {
      ...board,
      stages: board.stages.map((s) =>
        s.id === "s1" ? { ...s, deals: [deal({ id: "d9", name: "Phone deal", stage: qualified, primary_contact: { id: "c9", name: "Rahul Mehta", email: "", phone: "12345", whatsapp_opt_in: true } })] } : s,
      ),
    };
    renderBoard({ board: badPhone });
    const card = screen.getByTestId("deal-card-d9");
    expect(within(card).getByRole("button", { name: "Call Rahul Mehta: no phone number" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "WhatsApp Rahul Mehta: no phone number" })).toHaveAttribute("title", "No phone number");
  });

  it("keeps an ordinary phone call for a member who may not use WhatsApp", () => {
    const withPhone: Board = {
      ...board,
      stages: board.stages.map((s) =>
        s.id === "s1" ? { ...s, deals: [deal({ id: "d9", name: "Phone deal", stage: qualified, primary_contact: { id: "c9", name: "Rahul Mehta", email: "", phone: "+91 98765-43210", whatsapp_opt_in: true } })] } : s,
      ),
    };
    renderBoard({ board: withPhone, canWhatsApp: false });
    const card = screen.getByTestId("deal-card-d9");
    expect(within(card).getByRole("link", { name: "Call Rahul Mehta" })).toHaveAttribute("href", "tel:+919876543210");
    expect(within(card).queryByRole("link", { name: /WhatsApp/ })).not.toBeInTheDocument();
  });

  it("switches Call and WhatsApp off when no number is available, without hiding them", () => {
    renderBoard();
    const card = screen.getByTestId("deal-card-d1");
    expect(within(card).getByRole("button", { name: "Call Acme: no phone number" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "WhatsApp Acme: no phone number" })).toBeDisabled();
  });

  it("hides WhatsApp and Follow-up from members without those permissions", () => {
    renderBoard({ canWhatsApp: false, canFollowUp: false });
    const card = screen.getByTestId("deal-card-d1");
    expect(within(card).queryByRole("button", { name: /WhatsApp/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole("link", { name: /WhatsApp/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /follow-up/ })).not.toBeInTheDocument();
  });

  it("shows the outcome and closing date on closed deals, with no follow-up to plan", () => {
    const won = { id: "s3", name: "Won", kind: "won", color_token: "green" } as const;
    const closed: Board = {
      ...board,
      stages: board.stages.map((s) => (s.id === "s3" ? { ...s, deals: [deal({ id: "d7", name: "Closed deal", stage: won, status: "won", closed_at: "2026-11-05T10:00:00Z" })] } : s)),
    };
    renderBoard({ board: closed });
    const card = screen.getByTestId("deal-card-d7");
    expect(within(card).getByText("Won")).toBeInTheDocument();
    expect(within(card).getByText(/^Closed:/)).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /follow-up/ })).not.toBeInTheDocument();
    expect(within(card).queryByText("No next step")).not.toBeInTheDocument();
  });

  it("adds a deal to a stage and shows its weighted total from the column menu", async () => {
    const user = userEvent.setup();
    const onAddDeal = vi.fn();
    renderBoard({ onAddDeal });
    await user.click(screen.getByRole("button", { name: "Qualified options" }));
    expect(await screen.findAllByText("Weighted $1,800.00")).toHaveLength(2); // the menu, and the column's screen-reader line
    await user.click(screen.getByRole("menuitem", { name: "Add Deal" }));
    expect(onAddDeal).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
  });

  it("keeps the server's weighted total on a truncated column, offers the rest, and hides the risk dot without ai.scores.view", () => {
    const truncated: Board = { ...board, stages: board.stages.map((s) => (s.id === "s1" ? { ...s, has_more: true, deal_count: 5 } : s)) };
    renderBoard({ board: truncated, showRisk: false });
    expect(within(screen.getByTestId("column-s1")).getByText("Weighted $1,800.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show 3 more" })).toBeInTheDocument();
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
