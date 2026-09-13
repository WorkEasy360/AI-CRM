"use client";

import * as React from "react";
import { CalendarDays, CheckCircle2, ListTodo, Phone, Plus } from "lucide-react";
import { ActivityFormDialog } from "@/components/activities/activity-form-dialog";
import { ActivityItem } from "@/components/activities/activity-item";
import { KIND_LABELS } from "@/components/activities/activity-utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { listRecordActivities } from "@/lib/api/crm";
import { ACTIVITY_KINDS, ENTITY_LABELS, type Activity, type ActivityKind, type ListParams, type NamedRef, type RelatedEntityType } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { cn } from "@/lib/utils";

type View = "open" | "completed";

const KIND_ICONS: Record<ActivityKind, React.ReactNode> = { task: <ListTodo />, call: <Phone />, meeting: <CalendarDays /> };

function kindsLabel(kinds: readonly ActivityKind[]): string {
  if (kinds.length === 1) return KIND_LABELS[kinds[0]!].plural.toLowerCase();
  return "activities";
}

/**
 * Activities linked to one contact, company or deal: Open | Completed segments, quick "+ Task / Call /
 * Meeting" buttons, cursor-paginated rows. Embedded in the record detail pages.
 */
export function RecordActivities({
  entity,
  recordId,
  record,
  kinds = ACTIVITY_KINDS,
  title = "Activities",
  emptyDescription,
}: {
  entity: RelatedEntityType;
  recordId: string;
  /** Linked records used to prefill the create dialog. */
  record?: { contact?: { id: string; name: string } | null; company?: NamedRef | null; deal?: NamedRef | null };
  kinds?: readonly ActivityKind[];
  title?: string;
  emptyDescription?: string;
}) {
  const { data: session } = useSession();
  const canCreate = can(session?.active, "activities.create");
  const [view, setView] = React.useState<View>("open");
  const [creating, setCreating] = React.useState<ActivityKind | null>(null);

  const params = React.useMemo<ListParams>(
    () => ({
      open: view === "open" ? "true" : "false",
      sort: view === "open" ? "start_at" : "-start_at",
      kind: kinds.length === 1 ? kinds[0] : undefined,
    }),
    [view, kinds],
  );
  const list = useCursorList<Activity>(
    crmKeys.recordActivities(entity, recordId, params),
    (cursor) => listRecordActivities(entity, recordId, params, cursor),
    true,
    { recordKey: (a) => crmKeys.activity(a.id) },
  );
  // The API filters one kind at a time; narrow a multi-kind subset client-side.
  const items = kinds.length === ACTIVITY_KINDS.length || kinds.length === 1 ? list.items : list.items.filter((a) => kinds.includes(a.kind));

  const defaults = React.useMemo(() => {
    if (record) return record;
    const self = { id: recordId, name: `This ${ENTITY_LABELS[entity].singular.toLowerCase()}` };
    return { contact: entity === "contact" ? self : null, company: entity === "company" ? self : null, deal: entity === "deal" ? self : null };
  }, [record, recordId, entity]);

  const noun = kindsLabel(kinds);

  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="inline-flex h-7 items-center gap-0.5 rounded-sm bg-bg-subtle p-0.5" role="group" aria-label="Show">
          {(["open", "completed"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={cn("h-6 rounded-sm px-2 text-xs font-medium capitalize transition-colors", view === v ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg")}
            >
              {v}
            </button>
          ))}
        </div>
        {canCreate ? (
          <div className="ml-auto flex flex-wrap items-center gap-1">
            {kinds.map((k) => (
              <Button key={k} size="sm" variant="secondary" onClick={() => setCreating(k)} aria-label={`New ${KIND_LABELS[k].singular.toLowerCase()}`}>
                <Plus /> {KIND_LABELS[k].singular}
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      {list.isPending ? (
        <SkeletonRows rows={3} />
      ) : list.isError ? (
        <EmptyState
          title={`Could not load ${noun}`}
          description={errorMessage(list.error)}
          className="py-8"
          action={
            <Button variant="secondary" size="sm" onClick={() => list.refetch()}>
              Try again
            </Button>
          }
        />
      ) : items.length === 0 ? (
        view === "open" ? (
          <EmptyState
            icon={KIND_ICONS[kinds[0] ?? "task"]}
            title={`No open ${noun}`}
            description={emptyDescription ?? `Tasks, calls and meetings linked to this ${ENTITY_LABELS[entity].singular.toLowerCase()} show up here. Schedule the next step so nothing slips.`}
            className="py-8"
            action={
              canCreate ? (
                <Button size="sm" onClick={() => setCreating(kinds[0] ?? "task")}>
                  <Plus /> New {KIND_LABELS[kinds[0] ?? "task"].singular.toLowerCase()}
                </Button>
              ) : null
            }
          />
        ) : (
          <EmptyState icon={<CheckCircle2 />} title={`No completed ${noun} yet`} description="Completed and cancelled items move here." className="py-8" />
        )
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((a) => (
            <li key={a.id}>
              <ActivityItem activity={a} compact />
            </li>
          ))}
        </ul>
      )}
      {list.hasMore ? (
        <Button variant="secondary" size="sm" onClick={() => list.loadMore()} loading={list.isLoadingMore} className="self-center">
          Load more
        </Button>
      ) : null}

      {creating ? (
        <ActivityFormDialog open onOpenChange={(open) => !open && setCreating(null)} kind={creating} mode="schedule" defaults={defaults} />
      ) : null}
    </section>
  );
}
