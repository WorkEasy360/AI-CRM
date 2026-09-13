import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsMenu, notificationHref, relativeTime } from "@/components/shell/notifications-menu";
import { ToastProvider } from "@/components/ui/toast";
import type { Notification } from "@/lib/api/crm-types";

vi.mock("@/lib/api/crm", () => ({
  listNotifications: vi.fn(),
  unreadNotificationCount: vi.fn(),
  markNotificationsRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/pipeline",
}));

import { listNotifications, markAllNotificationsRead, markNotificationsRead, unreadNotificationCount } from "@/lib/api/crm";

const NOTIFICATIONS: Notification[] = [
  {
    id: "n1",
    kind: "deal_assigned",
    title: "Acme renewal assigned to you",
    body: "Sam handed over the deal.",
    entity_type: "deal",
    entity_id: "d1",
    read_at: null,
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  },
  {
    id: "n2",
    kind: "task_due",
    title: "Call Ann back",
    body: "",
    entity_type: "activity",
    entity_id: "a1",
    read_at: "2026-09-01T00:00:00Z",
    created_at: "2026-09-01T00:00:00Z",
  },
];

function renderMenu() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <NotificationsMenu />
      </ToastProvider>
    </QueryClientProvider>,
  );
  return client;
}

describe("NotificationsMenu", () => {
  beforeEach(() => {
    push.mockReset();
    vi.mocked(unreadNotificationCount).mockReset().mockResolvedValue({ count: 1 });
    vi.mocked(listNotifications).mockReset().mockResolvedValue({ next: null, previous: null, results: NOTIFICATIONS });
    vi.mocked(markNotificationsRead).mockReset().mockResolvedValue({ updated: 1 });
    vi.mocked(markAllNotificationsRead).mockReset().mockResolvedValue({ updated: 1 });
  });

  it("labels the bell with the unread count and shows the badge", async () => {
    renderMenu();
    expect(await screen.findByRole("button", { name: "Notifications, 1 unread" })).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    // The list is only fetched once the menu opens.
    expect(listNotifications).not.toHaveBeenCalled();
  });

  it("marks a notification read and navigates to its record", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }));
    const item = await screen.findByRole("menuitem", { name: "Unread: Acme renewal assigned to you" });
    expect(screen.getByText("Sam handed over the deal.")).toBeInTheDocument();
    expect(screen.getByText("5 minutes ago")).toBeInTheDocument();
    await user.click(item);

    await waitFor(() => expect(markNotificationsRead).toHaveBeenCalledWith(["n1"]));
    expect(push).toHaveBeenCalledWith("/deals/d1");
  });

  it("does not re-mark an already read notification", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }));
    await user.click(await screen.findByRole("menuitem", { name: "Call Ann back" }));

    expect(markNotificationsRead).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith("/activities?open=a1");
  });

  it("marks everything read and refreshes the count", async () => {
    const user = userEvent.setup();
    renderMenu();

    await user.click(await screen.findByRole("button", { name: "Notifications, 1 unread" }));
    await screen.findByRole("menuitem", { name: "Call Ann back" });
    vi.mocked(unreadNotificationCount).mockResolvedValue({ count: 0 });
    await user.click(screen.getByRole("menuitem", { name: "Mark all read" }));

    await waitFor(() => expect(markAllNotificationsRead).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(unreadNotificationCount).toHaveBeenCalledTimes(2));
    // Radix hides the rest of the page from assistive tech while the menu is open.
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("button", { name: "Notifications, 0 unread" })).toBeInTheDocument();
  });

  it("shows the caught-up state and a link to the preferences", async () => {
    vi.mocked(unreadNotificationCount).mockResolvedValue({ count: 0 });
    vi.mocked(listNotifications).mockResolvedValue({ next: null, previous: null, results: [] });
    const user = userEvent.setup();
    renderMenu();

    await user.click(await screen.findByRole("button", { name: "Notifications, 0 unread" }));
    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Mark all read" })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("menuitem", { name: "Preferences" }));
    expect(push).toHaveBeenCalledWith("/settings/notifications");
  });

  it("builds entity links and relative times", () => {
    expect(notificationHref({ entity_type: "contact", entity_id: "c 1" })).toBe("/contacts/c%201");
    expect(notificationHref({ entity_type: "company", entity_id: "co1" })).toBe("/companies/co1");
    expect(notificationHref({ entity_type: "", entity_id: null })).toBeNull();
    const now = new Date("2026-09-13T12:00:00Z");
    expect(relativeTime("2026-09-13T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-09-13T09:00:00Z", now)).toBe("3 hours ago");
    expect(relativeTime("2026-09-12T12:00:00Z", now)).toBe("yesterday");
    expect(relativeTime("not a date", now)).toBe("");
  });
});
