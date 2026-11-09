"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { CalendarCheck, Plus } from "lucide-react";
import { useCompleteActivity } from "@/components/activities/activity-item";
import { CallLink, WhatsAppButton } from "@/components/crm/contact-actions";
import { useQuickCreate } from "@/components/shell/quick-create-provider";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { getMyDay, listActivities } from "@/lib/api/crm";
import type { Activity } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { formatDayMonth } from "@/lib/crm/due-date";
import { crmKeys } from "@/lib/crm/keys";
import { hasPermission, useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

const WhatsAppDialog = dynamic(() => import("@/components/messaging/whatsapp-dialog").then((m) => m.WhatsAppDialog), { ssr: false });

type Bucket = "today" | "upcoming" | "overdue";
const BUCKET_LABELS: Record<Bucket, string> = { today: "Today", upcoming: "Upcoming", overdue: "Overdue" };
const UPCOMING_LIMIT = 50;

const byStart = (a: Activity, b: Activity) => (a.start_at ?? "").localeCompare(b.start_at ?? "");

function timeOf(value: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function isLaterThanToday(value: string, now = new Date()): boolean {
  return new Date(value).getTime() >= new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
}

/**
 * The phone's Tasks: the member's own open work. Today and Overdue are the "my day" answer, worked out on
 * the server in the member's time zone; Upcoming is everything after today, so nothing shows in two tabs.
 */
export function PhoneTasks() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canCreate = hasPermission(active, "activities.create");
  const canComplete = hasPermission(active, "activities.update");
  const canWhatsApp = hasPermission(active, "whatsapp.send");
  const { open } = useQuickCreate();
  const complete = useCompleteActivity();
  const [bucket, setBucket] = React.useState<Bucket>("today");
  const [messaging, setMessaging] = React.useState<Activity | null>(null);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const day = useQuery({ queryKey: crmKeys.myDay(tz), queryFn: () => getMyDay(tz), staleTime: 30_000 });
  const upcomingParams = { open: "1", top_level: "1", owner: "me", due: "upcoming", sort: "start_at", limit: String(UPCOMING_LIMIT) };
  const upcoming = useQuery({ queryKey: ["crm", "activities", "phone-upcoming", tz], queryFn: () => listActivities(upcomingParams), staleTime: 30_000 });

  const rows = React.useMemo<Record<Bucket, Activity[]>>(
    () => ({
      today: day.data ? [...day.data.tasks, ...day.data.events, ...day.data.calls, ...day.data.no_date].filter((a) => a.status !== "completed").sort(byStart) : [],
      overdue: day.data?.overdue ?? [],
      upcoming: (upcoming.data?.results ?? []).filter((a) => a.start_at && isLaterThanToday(a.start_at)),
    }),
    [day.data, upcoming.data],
  );
  const query = bucket === "upcoming" ? upcoming : day;
  const shown = rows[bucket];

  return (
    <div className="flex w-full flex-col gap-3">
      <h1 className="sr-only">Tasks and follow-ups</h1>
      <div role="group" aria-label="When" className="scroll-x flex gap-2">
        {(Object.keys(BUCKET_LABELS) as Bucket[]).map((key) => {
          const loaded = key === "upcoming" ? upcoming.isSuccess : day.isSuccess;
          const more = key === "upcoming" && upcoming.data?.next ? "+" : "";
          return (
            <button
              key={key}
              type="button"
              aria-pressed={bucket === key}
              onClick={() => setBucket(key)}
              className={cn("h-10 shrink-0 rounded-lg border px-3.5 text-sm font-semibold transition-colors", bucket === key ? "border-brand bg-brand text-brand-fg shadow-sm" : "border-border bg-surface text-fg")}
            >
              {BUCKET_LABELS[key]}
              {loaded ? ` (${rows[key].length}${more})` : ""}
            </button>
          );
        })}
      </div>

      {query.isPending ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : query.isError ? (
        <EmptyState title="Could not load your tasks" description={errorMessage(query.error)} />
      ) : shown.length === 0 ? (
        <EmptyState icon={<CalendarCheck />} title={bucket === "overdue" ? "Nothing overdue" : bucket === "upcoming" ? "Nothing coming up" : "Nothing left for today"} description="Tap + to add a task or follow-up." />
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((a) => {
            const who = a.contact?.name || a.company?.name || a.deal?.name || "";
            const detail = a.description.trim().split("\n")[0] || who;
            const when = a.start_at ? (bucket === "today" ? (a.all_day ? "All day" : timeOf(a.start_at)) : formatDayMonth(a.start_at)) : "No date";
            return (
              <li key={a.occurrence_key ?? a.id} className="flex items-start gap-1 rounded-xl border border-border bg-surface py-2 pr-3 pl-1 shadow-sm">
                {canComplete && !a.occurrence_of ? (
                  // The label is the 44px touch target around the smaller box.
                  <label className="flex size-11 shrink-0 cursor-pointer items-center justify-center">
                    <input type="checkbox" className="size-5 accent-[var(--kl-brand)]" checked={false} disabled={complete.isPending} onChange={() => complete.mutate({ activity: a })} aria-label={`Mark ${a.title} done`} />
                  </label>
                ) : (
                  <span className="size-3 shrink-0" />
                )}
                <Link href={`/activities?open=${encodeURIComponent(a.occurrence_of ?? a.id)}`} className="min-w-0 flex-1 rounded-md py-1 focus-visible:outline-2 focus-visible:outline-ring">
                  <span className="line-clamp-2 text-sm font-bold text-fg">{a.title}</span>
                  {detail && detail !== a.title ? <span className="block truncate text-sm text-fg-muted">{detail}</span> : null}
                  <span className={cn("mt-1 inline-block rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums", bucket === "upcoming" ? "bg-bg-subtle text-fg-muted" : "bg-danger-soft text-danger")}>{when}</span>
                </Link>
                <span className="flex shrink-0 items-center gap-1.5 self-center">
                  <CallLink phone={a.contact?.phone} name={who || a.title} />
                  {canWhatsApp ? <WhatsAppButton phone={a.contact?.phone} name={who || a.title} onClick={() => setMessaging(a)} /> : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <Link href="/activities?tab=all" className="flex min-h-11 items-center justify-center text-sm font-semibold text-primary">
        All activities, calendar and filters
      </Link>

      {canCreate ? (
        <button
          type="button"
          onClick={() => open("task")}
          aria-label="Add a task"
          className="fixed right-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-20 flex size-14 items-center justify-center rounded-full bg-brand text-brand-fg shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Plus className="size-7" aria-hidden />
        </button>
      ) : null}

      {messaging?.contact?.phone ? (
        <WhatsAppDialog
          open
          onOpenChange={(next) => !next && setMessaging(null)}
          deal={messaging.deal}
          contact={{ id: messaging.contact.id, name: messaging.contact.name, phone: messaging.contact.phone, whatsapp_opt_in: Boolean(messaging.contact.whatsapp_opt_in) }}
        />
      ) : null}
    </div>
  );
}
