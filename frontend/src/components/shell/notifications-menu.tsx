"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CalendarDays, CheckCheck, Clock, Handshake, ListTodo, Phone, Reply, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { listNotifications, markAllNotificationsRead, markNotificationsRead, unreadNotificationCount } from "@/lib/api/crm";
import type { Notification, NotificationKind } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { cn } from "@/lib/utils";

const KIND_ICONS: Record<NotificationKind, React.ComponentType<{ className?: string }>> = {
  task_due: ListTodo,
  meeting_soon: CalendarDays,
  call_soon: Phone,
  deal_assigned: Handshake,
  deal_inactive: Clock,
  customer_replied: Reply,
  ai_high_risk: TriangleAlert,
};

/** Where a notification leads. Null when it is not attached to a record. */
export function notificationHref(notification: Pick<Notification, "entity_type" | "entity_id">): string | null {
  const id = notification.entity_id;
  if (!id) return null;
  const enc = encodeURIComponent(id);
  switch (notification.entity_type) {
    case "deal":
      return `/deals/${enc}`;
    case "contact":
      return `/contacts/${enc}`;
    case "company":
      return `/companies/${enc}`;
    case "activity":
      return `/activities?open=${enc}`;
    default:
      return null;
  }
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "3 minutes ago", "yesterday", "in 2 hours"; "just now" inside a minute. */
export function relativeTime(value: string, now: Date = new Date()): string {
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((then - now.getTime()) / 1000);
  if (Math.abs(seconds) < 60) return "just now";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

const COUNT_REFRESH_MS = 60_000;

/** The header bell: unread badge, latest notifications, mark read, and a link to the preferences. */
export function NotificationsMenu() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);

  const countQuery = useQuery({
    queryKey: crmKeys.notificationCount,
    queryFn: () => unreadNotificationCount(),
    refetchInterval: COUNT_REFRESH_MS,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
  const unread = countQuery.data?.count ?? 0;

  const listQuery = useQuery({
    queryKey: crmKeys.notifications(false),
    queryFn: () => listNotifications(false),
    enabled: open,
  });
  const items = listQuery.data?.results ?? [];

  const invalidate = React.useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: crmKeys.notifications(false) }),
      queryClient.invalidateQueries({ queryKey: crmKeys.notifications(true) }),
      queryClient.invalidateQueries({ queryKey: crmKeys.notificationCount }),
    ]);
  }, [queryClient]);

  const markRead = useMutation({
    mutationFn: (ids: string[]) => markNotificationsRead(ids),
    onSettled: invalidate,
    onError: (error) => toast({ tone: "error", title: "Could not update notification", description: errorMessage(error) }),
  });
  const markAll = useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSettled: invalidate,
    onError: (error) => toast({ tone: "error", title: "Could not mark all as read", description: errorMessage(error) }),
  });

  const openNotification = (notification: Notification) => {
    if (!notification.read_at) markRead.mutate([notification.id]);
    const href = notificationHref(notification);
    if (href) router.push(href);
  };

  const label = `Notifications, ${unread} unread`;
  const badge = unread > 99 ? "99+" : String(unread);

  let body: React.ReactNode;
  if (listQuery.isError) {
    body = (
      <p role="alert" className="px-3 py-6 text-center text-sm text-danger">
        {errorMessage(listQuery.error, "Notifications are unavailable right now.")}
      </p>
    );
  } else if (listQuery.isPending) {
    body = (
      <p role="status" className="px-3 py-6 text-center text-sm text-fg-muted">
        Loading…
      </p>
    );
  } else if (items.length === 0) {
    body = (
      <div className="flex flex-col items-center gap-1 px-3 py-8 text-center">
        <span className="flex size-9 items-center justify-center rounded-full bg-bg-subtle text-fg-subtle">
          <Bell className="size-4" aria-hidden />
        </span>
        <p className="text-sm font-medium text-fg">You&apos;re all caught up</p>
        <p className="text-xs text-fg-muted">Reminders, replies and assignments will show up here.</p>
      </div>
    );
  } else {
    body = items.map((notification) => {
      const Icon = KIND_ICONS[notification.kind] ?? Bell;
      const isUnread = !notification.read_at;
      return (
        <DropdownMenuItem
          key={notification.id}
          onSelect={() => openNotification(notification)}
          className="items-start gap-2.5 px-2 py-2"
          aria-label={`${isUnread ? "Unread: " : ""}${notification.title}`}
        >
          <span className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-sm", isUnread ? "bg-primary-soft" : "bg-bg-subtle")}>
            <Icon className={cn("size-4", isUnread ? "text-primary" : "text-fg-subtle")} />
          </span>
          <span className="min-w-0 flex-1">
            <span className={cn("block truncate text-sm", isUnread ? "font-medium text-fg" : "text-fg-muted")}>{notification.title}</span>
            {notification.body ? <span className="line-clamp-2 text-xs text-fg-muted">{notification.body}</span> : null}
            <span className="block text-[11px] text-fg-subtle">{relativeTime(notification.created_at)}</span>
          </span>
          {isUnread ? <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden /> : null}
        </DropdownMenuItem>
      );
    });
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="relative" aria-label={label}>
          <Bell />
          {unread > 0 ? (
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-fg"
            >
              {badge}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(22rem,calc(100vw-1.5rem))] p-0" aria-label="Notifications">
        <div className="flex h-10 items-center justify-between border-b border-border pl-3 pr-1.5">
          <span className="text-sm font-semibold text-fg">Notifications</span>
          {/* A menu item (not a button): Radix menus keep Tab inside, so only items are keyboard-reachable. */}
          <DropdownMenuItem
            disabled={unread === 0 || markAll.isPending}
            className="h-7 px-2 text-xs font-medium text-fg-muted"
            onSelect={(event) => {
              event.preventDefault();
              markAll.mutate();
            }}
          >
            <CheckCheck className="size-3.5!" /> Mark all read
          </DropdownMenuItem>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-1">{body}</div>
        <DropdownMenuSeparator className="my-0 mx-0" />
        <div className="p-1">
          <DropdownMenuItem onSelect={() => router.push("/settings/notifications")}>
            <SlidersHorizontal /> Preferences
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
