"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ChevronDown, ListTodo, Phone, PhoneIncoming, Plus } from "lucide-react";
import { ActivityList } from "@/components/activities/activity-list";
import { KIND_LABELS } from "@/components/activities/activity-utils";
import { Calendar } from "@/components/activities/calendar";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { activitySummary, getActivity } from "@/lib/api/crm";
import { ACTIVITY_KINDS, type Activity, type ActivityKind } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import { useListParams } from "@/lib/crm/use-list-params";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

// Rendered only while creating or editing; its form code loads at that moment.
const ActivityFormDialog = dynamic(() => import("@/components/activities/activity-form-dialog").then((m) => m.ActivityFormDialog), { ssr: false });

const TABS = ["calendar", "tasks", "meetings", "calls"] as const;
type Tab = (typeof TABS)[number];
const TAB_KIND: Record<Exclude<Tab, "calendar">, ActivityKind> = { tasks: "task", meetings: "meeting", calls: "call" };
const URL_KEYS = ["tab", "view", "q", "due", "sort", "new", "kind", "open"] as const;

function tabOf(value: string | undefined): Tab {
  if (value === "events") return "meetings"; // older links
  return (TABS as readonly string[]).includes(value ?? "") ? (value as Tab) : "calendar";
}

function kindOf(value: string | undefined): ActivityKind | null {
  return (ACTIVITY_KINDS as readonly string[]).includes(value ?? "") ? (value as ActivityKind) : null;
}

interface Creating {
  kind: ActivityKind;
  mode: "schedule" | "log";
  start_at?: string;
}

/** Small counters from the summary endpoint; each jumps to the matching list. */
function SummaryChips({ onPick }: { onPick: (tab: Tab, due?: string) => void }) {
  const summary = useQuery({ queryKey: crmKeys.activitySummary("me"), queryFn: () => activitySummary("me"), staleTime: 30_000 });
  if (summary.isPending) return <Skeleton className="h-6 w-64" />;
  if (summary.isError || !summary.data) return null;
  const s = summary.data;
  const chips: { label: string; value: number; tab: Tab; due?: string; tone?: "danger" | "warning" }[] = [
    { label: "Overdue", value: s.overdue, tab: "tasks", due: "overdue", tone: s.overdue > 0 ? "danger" : undefined },
    { label: "Due today", value: s.due_today, tab: "tasks", due: "today", tone: s.due_today > 0 ? "warning" : undefined },
    { label: "Meetings this week", value: s.meetings_week, tab: "meetings", due: "week" },
    { label: "Calls this week", value: s.calls_week, tab: "calls", due: "week" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="My activity summary">
      {chips.map((c) => (
        <button
          key={c.label}
          type="button"
          onClick={() => onPick(c.tab, c.due)}
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-xs transition-colors hover:bg-bg-subtle",
            c.tone === "danger" ? "border-danger/30 bg-danger-soft text-danger" : c.tone === "warning" ? "border-warning/30 bg-warning-soft text-warning" : "border-border bg-surface text-fg-muted",
          )}
        >
          <span className="font-semibold tabular-nums">{c.value}</span> {c.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Activities: Calendar | Tasks | Meetings | Calls. The tab and list filters live in the URL;
 * `?new=1&kind=…` opens the create dialog and `?open=<id>` opens an activity for editing.
 */
export function ActivitiesPage() {
  const { data: session } = useSession();
  const canCreate = can(session?.active, "activities.create");
  const { params, setParam, setParams } = useListParams(URL_KEYS);
  const tab = tabOf(params.tab);
  const { toast } = useToast();
  const [creating, setCreating] = React.useState<Creating | null>(null);
  const [editing, setEditing] = React.useState<Activity | null>(null);

  // ?new=1&kind=task|call|meeting (from the sidebar "+ New" menu)
  React.useEffect(() => {
    if (params.new !== "1") return;
    const kind = kindOf(params.kind) ?? (tab === "calendar" ? "meeting" : TAB_KIND[tab]);
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

  const defaultKind: ActivityKind = tab === "calendar" ? "meeting" : TAB_KIND[tab];
  const startCreate = (kind: ActivityKind, mode: "schedule" | "log" = "schedule") => setCreating({ kind, mode });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Activities"
        description={<SummaryChips onPick={(next, due) => setParams({ tab: next, due, view: undefined, q: undefined })} />}
        actions={
          canCreate ? (
            <div className="inline-flex items-center">
              <Button size="sm" onClick={() => startCreate(defaultKind)} className="rounded-r-none">
                <Plus /> New {KIND_LABELS[defaultKind].singular.toLowerCase()}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" aria-label="More ways to add" className="rounded-l-none border-l border-primary-fg/20 px-2">
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
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v === "calendar" ? undefined : v, view: undefined, q: undefined, due: undefined, sort: undefined })} className="flex min-h-0 flex-1 flex-col">
        <TabsList aria-label="Activity views" className="h-8 w-fit">
          {TABS.map((t) => (
            <TabsTrigger key={t} value={t} className="h-6 px-2.5 text-xs capitalize">
              {t}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="calendar" className="mt-3 flex min-h-0 flex-1 flex-col">
          {tab === "calendar" ? (
            <Calendar onSelect={setEditing} onCreate={canCreate ? (start_at) => setCreating({ kind: "meeting", mode: "schedule", start_at }) : undefined} />
          ) : null}
        </TabsContent>
        {(["tasks", "meetings", "calls"] as const).map((key) => (
          <TabsContent key={key} value={key} className="mt-3">
            {tab === key ? <ActivityList kind={TAB_KIND[key]} params={params} setParam={setParam} setParams={setParams} canCreate={canCreate} onCreate={startCreate} /> : null}
          </TabsContent>
        ))}
      </Tabs>

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
