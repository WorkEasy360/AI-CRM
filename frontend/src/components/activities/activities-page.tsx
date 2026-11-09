"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { CalendarCheck, CalendarDays, CheckSquare, ChevronDown, ListTodo, Phone, PhoneIncoming, Plus, Table2 } from "lucide-react";
import { MiniCalendar, OverdueCard, TodaySchedule, UpcomingCard } from "@/components/activities/activities-side";
import { ActivityList } from "@/components/activities/activity-list";
import { ActivityTable } from "@/components/activities/activity-table";
import { KpiTile, percentChange } from "@/components/dashboard/stat-tile";
import { KIND_LABELS } from "@/components/activities/activity-utils";
import { Calendar } from "@/components/activities/calendar";
import { MessageLog } from "@/components/activities/message-log";
import { MyDay } from "@/components/activities/my-day";
import { PhoneTasks } from "@/components/activities/phone-tasks";
import { useIsPhone } from "@/lib/use-is-phone";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { activitySummary, getActivity } from "@/lib/api/crm";
import { ACTIVITY_KINDS, type Activity, type ActivityKind, type ActivitySummary } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import { useListParams } from "@/lib/crm/use-list-params";
import { useSession } from "@/lib/session";

// Rendered only while creating or editing; its form code loads at that moment.
const ActivityFormDialog = dynamic(() => import("@/components/activities/activity-form-dialog").then((m) => m.ActivityFormDialog), { ssr: false });

// The WorkEasy360 order: everything, each kind, follow-ups, then the conversations and the calendars.
const TABS = ["all", "tasks", "calls", "meetings", "followups", "whatsapp", "emails", "calendar", "day"] as const;
type Tab = (typeof TABS)[number];
const DEFAULT_TAB: Tab = "all";
type KindTab = "tasks" | "meetings" | "calls";
const TAB_KIND: Record<KindTab, ActivityKind> = { tasks: "task", meetings: "meeting", calls: "call" };
const TAB_LABELS: Record<Tab, string> = {
  all: "All Activities",
  tasks: "Tasks",
  calls: "Calls",
  meetings: "Meetings",
  followups: "Follow-ups",
  whatsapp: "WhatsApp",
  emails: "Emails",
  calendar: "Calendar",
  day: "My Day",
};
const LIST_TABS = ["all", "tasks", "calls", "meetings", "followups"] as const;

function tabKind(tab: Tab): ActivityKind {
  if (tab === "calendar") return "meeting";
  if (tab === "tasks" || tab === "meetings" || tab === "calls") return TAB_KIND[tab];
  return "task";
}
const URL_KEYS = ["tab", "view", "q", "due", "sort", "new", "kind", "open", "type", "status", "owner", "range", "from", "to", "layout"] as const;

function tabOf(value: string | undefined): Tab {
  if (value === "events") return "meetings"; // older links
  return (TABS as readonly string[]).includes(value ?? "") ? (value as Tab) : DEFAULT_TAB;
}

function kindOf(value: string | undefined): ActivityKind | null {
  return (ACTIVITY_KINDS as readonly string[]).includes(value ?? "") ? (value as ActivityKind) : null;
}

interface Creating {
  kind: ActivityKind;
  mode: "schedule" | "log";
  start_at?: string;
}

/** Totals by kind across what the member may see, with what was logged in the last 30 days vs the 30 before. */
function ActivityKpis({ summary }: { summary: ActivitySummary | undefined }) {
  const created = summary?.created;
  const versus = created ? `new in the last ${created.days} days vs the ${created.days} before` : "";
  const change = (key: "all" | "task" | "call" | "meeting") => (created ? percentChange(created.current[key], created.previous[key], versus) : null);
  const value = (key: "all" | "task" | "call" | "meeting") => (summary ? (summary.totals?.[key] ?? 0).toLocaleString() : undefined);
  return (
    <section aria-label="Activity summary" className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4">
      <KpiTile tone="green" icon={<CheckSquare />} label="Total Activities" value={value("all")} change={change("all")} changeNote="" sub="All activities" />
      <KpiTile tone="blue" icon={<ListTodo />} label="Tasks" value={value("task")} change={change("task")} changeNote="" sub={summary ? `${summary.open_tasks} open` : undefined} />
      <KpiTile tone="orange" icon={<Phone />} label="Calls" value={value("call")} change={change("call")} changeNote="" sub={summary ? `${summary.calls_week} this week` : undefined} />
      <KpiTile tone="purple" icon={<CalendarDays />} label="Meetings" value={value("meeting")} change={change("meeting")} changeNote="" sub={summary ? `${summary.meetings_week} this week` : undefined} />
    </section>
  );
}

/**
 * Activities: Calendar | My day | Tasks | Meetings | Calls. The tab and list filters live in the URL;
 * `?new=1&kind=…` opens the create dialog and `?open=<id>` opens an activity for editing.
 */
export function ActivitiesPage() {
  const { data: session } = useSession();
  const canCreate = can(session?.active, "activities.create");
  const canBulk = can(session?.active, "activities.bulk_update");
  const canWhatsApp = can(session?.active, "whatsapp.view");
  const canEmail = can(session?.active, "email.view");
  const visibleTabs = TABS.filter((t) => (t === "whatsapp" ? canWhatsApp : t === "emails" ? canEmail : true));
  const { params, setParam, setParams } = useListParams(URL_KEYS);
  const phone = useIsPhone();
  const tab = tabOf(params.tab);
  const { toast } = useToast();
  const [creating, setCreating] = React.useState<Creating | null>(null);
  const [editing, setEditing] = React.useState<Activity | null>(null);

  // ?new=1&kind=task|call|meeting (from the sidebar "+ New" menu)
  React.useEffect(() => {
    if (params.new !== "1") return;
    const kind = kindOf(params.kind) ?? tabKind(tab);
    if (canCreate) setCreating({ kind, mode: "schedule" });
    setParams({ new: undefined, kind: undefined });
  }, [params.new, params.kind, tab, canCreate, setParams]);

  // ?open=<id> (from notifications)
  const openId = params.open ?? "";
  const opened = useQuery({ queryKey: crmKeys.activity(openId), queryFn: () => getActivity(openId), enabled: Boolean(openId) });
  React.useEffect(() => {
    if (!openId) return;
    if (opened.data) {
      setEditing(opened.data);
      setParam("open", undefined);
    } else if (opened.isError) {
      toast({ tone: "error", title: "Could not open that activity", description: errorMessage(opened.error) });
      setParam("open", undefined);
    }
  }, [openId, opened.data, opened.isError, opened.error, setParam, toast]);

  const summary = useQuery({ queryKey: crmKeys.activitySummary(), queryFn: () => activitySummary(), staleTime: 30_000 });
  const grouped = params.layout === "grouped";
  const defaultKind: ActivityKind = tabKind(tab);
  const showTab = (next: Tab, patch: Record<string, string | undefined> = {}) =>
    setParams({ tab: next === DEFAULT_TAB ? undefined : next, view: undefined, q: undefined, due: undefined, sort: undefined, ...patch });
  const startCreate = (kind: ActivityKind, mode: "schedule" | "log" = "schedule") => setCreating({ kind, mode });

  // Phones open on the member's own tasks; a link to a tab or a filtered list still gets the full page.
  if (phone && !params.tab && !params.due && !params.view && !params.q) {
    return (
      <>
        <PhoneTasks />
        {creating ? <ActivityFormDialog open onOpenChange={(open) => !open && setCreating(null)} kind={creating.kind} mode={creating.mode} defaults={creating.start_at ? { start_at: creating.start_at } : undefined} /> : null}
        {editing ? <ActivityFormDialog open onOpenChange={(open) => !open && setEditing(null)} activity={editing} /> : null}
      </>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <PageHeader
        icon={CalendarCheck}
        title="Activities"
        actions={
          canCreate ? (
            <div className="inline-flex items-center">
              <Button size="sm" onClick={() => startCreate(defaultKind)} className="rounded-r-none">
                <Plus /> New {KIND_LABELS[defaultKind].singular.toLowerCase()}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" aria-label="More ways to add" className="rounded-l-none border-l border-brand-fg/20 px-2">
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => startCreate("task")}>
                    <ListTodo /> Task
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => startCreate("call")}>
                    <Phone /> Schedule call
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => startCreate("meeting")}>
                    <CalendarDays /> Meeting
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => startCreate("call", "log")}>
                    <PhoneIncoming /> Log a call
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null
        }
      />
      <div className="grid gap-4 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_21rem]">
      <div className="flex min-w-0 flex-col gap-4 xl:min-h-0">
      <ActivityKpis summary={summary.data} />
      <Tabs value={tab} onValueChange={(v) => showTab(v as Tab)} className="flex min-h-0 flex-1 flex-col">
        <TabsList aria-label="Activity views" className="h-auto w-fit max-w-full flex-wrap gap-1 rounded-xl border border-border bg-surface p-1 shadow-sm">
          {visibleTabs.map((t) => (
            <TabsTrigger key={t} value={t} className="h-9 rounded-lg px-3.5 text-sm data-[state=active]:bg-brand data-[state=active]:text-brand-fg">
              {TAB_LABELS[t]}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="calendar" className="mt-3 flex min-h-0 flex-1 flex-col">
          {tab === "calendar" ? (
            <Calendar
              // A repeating event's occurrence opens the event itself, so saving never moves the series.
              onSelect={(a) => (a.occurrence_of ? setParam("open", a.occurrence_of) : setEditing(a))}
              onCreate={canCreate ? (start_at) => setCreating({ kind: "meeting", mode: "schedule", start_at }) : undefined}
            />
          ) : null}
        </TabsContent>
        <TabsContent value="day" className="mt-3">
          {tab === "day" ? <MyDay onCreate={canCreate ? () => startCreate("task") : undefined} /> : null}
        </TabsContent>
        {LIST_TABS.map((key) => (
          <TabsContent key={key} value={key} className="mt-3">
            {tab !== key ? null : grouped && key !== "followups" ? (
              <div className="flex flex-col gap-2">
                <Button variant="secondary" size="sm" className="w-fit" onClick={() => setParam("layout", undefined)}>
                  <Table2 /> Table view
                </Button>
                <ActivityList kind={key === "all" ? undefined : TAB_KIND[key]} params={params} setParam={setParam} setParams={setParams} canCreate={canCreate} canBulk={canBulk} onCreate={startCreate} />
              </div>
            ) : (
              <ActivityTable
                kind={key === "all" || key === "followups" ? undefined : TAB_KIND[key]}
                followUps={key === "followups"}
                params={params}
                setParam={setParam}
                setParams={setParams}
                onEdit={setEditing}
                onCreate={startCreate}
                canCreate={canCreate}
                onShowCalendar={() => showTab("calendar")}
                onShowGrouped={() => setParam("layout", "grouped")}
              />
            )}
          </TabsContent>
        ))}
        <TabsContent value="whatsapp" className="mt-3">
          {tab === "whatsapp" && canWhatsApp ? <MessageLog channel="whatsapp" /> : null}
        </TabsContent>
        <TabsContent value="emails" className="mt-3">
          {tab === "emails" && canEmail ? <MessageLog channel="email" /> : null}
        </TabsContent>
      </Tabs>
      </div>

      <aside aria-label="Schedule" className="grid min-w-0 content-start gap-4">
        <TodaySchedule onOpen={setEditing} />
        <MiniCalendar
          selected={params.range === "custom" && params.from && params.from === params.to ? params.from : undefined}
          onPick={(day) =>
            setParams({
              tab: (LIST_TABS as readonly string[]).includes(tab) ? (tab === DEFAULT_TAB ? undefined : tab) : undefined,
              range: day ? "custom" : undefined,
              from: day,
              to: day,
            })
          }
        />
        <UpcomingCard summary={summary.data} onOpen={setEditing} onViewAll={() => showTab("all", { due: "week" })} />
        <OverdueCard summary={summary.data} onOpen={setEditing} onViewAll={() => showTab("all", { due: "overdue" })} />
      </aside>
      </div>

      {creating ? (
        <ActivityFormDialog
          open
          onOpenChange={(open) => !open && setCreating(null)}
          kind={creating.kind}
          mode={creating.mode}
          defaults={creating.start_at ? { start_at: creating.start_at } : undefined}
        />
      ) : null}
      {editing ? <ActivityFormDialog open onOpenChange={(open) => !open && setEditing(null)} activity={editing} /> : null}
    </div>
  );
}
