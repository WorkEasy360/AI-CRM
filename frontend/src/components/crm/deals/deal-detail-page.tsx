"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Archive, ArrowLeft, ArrowRightLeft, Building2, Pencil, RotateCcw, User } from "lucide-react";
import { RecordActivities } from "@/components/activities/record-activities";
import { CustomFieldsSummary, useCustomFields } from "@/components/crm/custom-fields-form";
import { DealCommunication } from "@/components/crm/deals/deal-communication";
import { DealContactsSection } from "@/components/crm/deals/deal-contacts-section";
import { DealFormDialog } from "@/components/crm/deals/deal-form-dialog";
import { relativeDayLabel } from "@/components/crm/deals/deal-helpers";
import { DealHistorySection } from "@/components/crm/deals/deal-history-section";
import { DealInsightsPanel, NextBestActionCard, RiskCard } from "@/components/crm/deals/deal-insights-panel";
import { DealLinesSection } from "@/components/crm/deals/deal-lines-section";
import { DealMetrics } from "@/components/crm/deals/deal-metrics";
import { DealSummaryCard } from "@/components/crm/deals/deal-summary-card";
import { useMoveStage, type StageTarget } from "@/components/crm/deals/move-stage-dialog";
import { NotesPanel } from "@/components/crm/notes-panel";
import { StatusBadge } from "@/components/crm/pipeline/deals-list";
import { QuickActions } from "@/components/crm/quick-actions";
import { Facts, RecordPageError, RecordPageSkeleton, Section } from "@/components/crm/record-page";
import { TagPicker } from "@/components/crm/tag-picker";
import { Timeline } from "@/components/crm/timeline";
import { useArchiveRestore } from "@/components/crm/use-record-mutations";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getDeal, getDealInsights, listPipelines } from "@/lib/api/crm";
import type { PipelineStage } from "@/lib/api/crm-types";
import { formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { can, canEditRecord } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { formatDate, formatDateTime } from "@/lib/utils";

const BACK = { href: "/pipeline", label: "Back to pipeline" };
const enc = encodeURIComponent;

/**
 * The deal command centre: who the customer is, what it is worth, where it stands, what happened,
 * what to do next, whether it is at risk and when it closes — all above the fold, then tabs.
 */
export function DealDetailPage({ id }: { id: string }) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const baseCurrency = active?.organization.base_currency ?? "USD";
  const deal = useQuery({ queryKey: crmKeys.record("deals", id), queryFn: () => getDeal(id) });
  const pipelines = useQuery({ queryKey: crmKeys.pipelines, queryFn: () => listPipelines(), staleTime: 60_000 });
  const insights = useQuery({ queryKey: crmKeys.dealInsights(id), queryFn: () => getDealInsights(id), enabled: deal.isSuccess, staleTime: 60_000 });
  const { definitions } = useCustomFields("deal");
  const { archive, restore } = useArchiveRestore("deal");
  const move = useMoveStage();
  const [editing, setEditing] = React.useState(false);
  const [confirmArchive, setConfirmArchive] = React.useState(false);

  if (deal.isPending) return <RecordPageSkeleton />;
  if (deal.isError) return <RecordPageError error={deal.error} backHref={BACK.href} backLabel="Pipeline" />;
  const record = deal.data;
  const archived = Boolean(record.archived_at);
  const editable = !archived && canEditRecord(active, "deals", record.owner?.id);
  const canMove = !archived && can(active, "deals.change_stage");
  const canArchive = !archived && can(active, "deals.delete");
  const canRestore = archived && can(active, "deals.restore");
  const canViewScores = can(active, "ai.scores.view");
  const canUseCopilot = can(active, "ai.copilot.use");
  const showActivities = can(active, "activities.view");
  const showCommunication = can(active, "email.view") || can(active, "whatsapp.view");
  const showInsights = canViewScores || canUseCopilot;
  const pipeline = pipelines.data?.results.find((p) => p.id === record.pipeline.id) ?? null;
  const stages: PipelineStage[] = pipeline ? pipeline.stages.filter((s) => !s.archived_at) : [];
  const moveTargets: StageTarget[] = stages.filter((s) => s.id !== record.stage.id);
  const contactRef = record.primary_contact ? { id: record.primary_contact.id, name: record.primary_contact.name, email: record.primary_contact.email } : null;
  const insightsData = insights.data ?? null;

  const facts = [
    {
      label: "Amount",
      value: `${formatMoney(record.amount, record.currency)}${record.currency !== baseCurrency ? ` · ${formatMoney(record.amount_base, baseCurrency)} at ${record.exchange_rate}` : ""}`,
    },
    { label: "Weighted value", value: formatMoney(record.weighted_amount_base, baseCurrency) },
    { label: "Pipeline / stage", value: `${record.pipeline.name} · ${record.stage.name}` },
    { label: "Probability", value: `${record.probability}%${record.probability_overridden ? " (manual)" : ""}` },
    { label: "Expected close", value: formatDate(record.expected_close_date) },
    { label: "Linked contacts", value: String(record.contact_count) },
    ...(record.status !== "open" ? [{ label: record.status === "won" ? "Won on" : "Lost on", value: formatDateTime(record.closed_at) }] : []),
    ...(record.status === "lost" && record.lost_reason ? [{ label: "Lost reason", value: record.lost_reason }] : []),
    ...(record.products_total !== null ? [{ label: "Products total", value: formatMoney(record.products_total, record.currency) }] : []),
  ];

  const tabs: { value: string; label: string; content: React.ReactNode }[] = [
    {
      value: "overview",
      label: "Overview",
      content: (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 lg:grid-cols-2">
            {insights.isPending ? (
              <SkeletonRows rows={2} className="lg:col-span-2" />
            ) : insightsData ? (
              <>
                <NextBestActionCard nba={insightsData.next_best_action} />
                {canViewScores && record.status === "open" ? <RiskCard risk={insightsData.risk} compact /> : null}
              </>
            ) : null}
          </div>
          <DealSummaryCard dealId={record.id} />
          <details open className="rounded-md border border-border bg-surface">
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold">Details</summary>
            <div className="flex flex-col gap-4 border-t border-border px-4 py-4">
              <Facts items={facts} />
              {record.description ? (
                <div>
                  <h3 className="mb-1 text-xs text-fg-subtle">Description</h3>
                  <p className="whitespace-pre-wrap break-words text-sm">{record.description}</p>
                </div>
              ) : null}
              {definitions.length > 0 ? (
                <div>
                  <h3 className="mb-2 text-xs text-fg-subtle">Custom fields</h3>
                  <CustomFieldsSummary definitions={definitions} value={record.custom_data} />
                </div>
              ) : null}
            </div>
          </details>
        </div>
      ),
    },
    {
      value: "timeline",
      label: "Timeline",
      content: (
        <div className="flex flex-col gap-4">
          <Timeline entity="deal" recordId={record.id} />
          <DealHistorySection dealId={record.id} />
        </div>
      ),
    },
    { value: "contacts", label: `Contacts${record.contact_count ? ` (${record.contact_count})` : ""}`, content: <DealContactsSection deal={record} editable={editable} /> },
    { value: "products", label: `Products${record.line_count ? ` (${record.line_count})` : ""}`, content: <DealLinesSection deal={record} editable={editable} /> },
    ...(showActivities
      ? [
          {
            value: "activities",
            label: "Activities",
            content: (
              <RecordActivities
                entity="deal"
                recordId={record.id}
                record={{ contact: contactRef ? { id: contactRef.id, name: contactRef.name } : null, company: record.company, deal: { id: record.id, name: record.name } }}
                emptyDescription="Schedule a call, meeting or task so this deal always has a next step."
              />
            ),
          },
        ]
      : []),
    ...(showCommunication ? [{ value: "communication", label: "Communication", content: <DealCommunication deal={record} /> }] : []),
    ...(showInsights
      ? [{ value: "insights", label: "AI Insights", content: <DealInsightsPanel deal={record} insights={insightsData} isPending={insights.isPending} error={insights.error} contact={contactRef} /> }]
      : []),
    { value: "notes", label: "Notes", content: <NotesPanel entity="deal" recordId={record.id} /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button asChild variant="link" size="sm" className="mb-2 h-auto px-0 text-fg-muted">
          <Link href={BACK.href}>
            <ArrowLeft /> {BACK.label}
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold tracking-tight">{record.name}</h1>
              {archived ? <Badge variant="warning">Archived</Badge> : null}
              <StatusBadge status={record.status} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
              {record.company ? (
                <Link href={`/companies/${enc(record.company.id)}`} className="inline-flex items-center gap-1 hover:text-primary hover:underline">
                  <Building2 className="size-3.5" aria-hidden /> {record.company.name}
                </Link>
              ) : null}
              {record.primary_contact ? (
                <Link href={`/contacts/${enc(record.primary_contact.id)}`} className="inline-flex items-center gap-1 hover:text-primary hover:underline">
                  <User className="size-3.5" aria-hidden /> {record.primary_contact.name}
                </Link>
              ) : (
                <span className="text-fg-subtle">No primary contact</span>
              )}
              <span className="inline-flex items-center gap-1.5">
                {record.owner ? <Avatar name={record.owner.display_name} size="sm" className="size-5 text-[9px]" /> : null}
                {record.owner ? record.owner.display_name : "Unassigned"}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {editable ? (
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            ) : null}
            {canMove && moveTargets.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="secondary" size="sm" loading={move.isPending}>
                    <ArrowRightLeft /> Move to…
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Move to stage</DropdownMenuLabel>
                  {moveTargets.map((s) => (
                    <DropdownMenuItem key={s.id} onSelect={() => move.requestMove(record, s)}>
                      {s.name}
                      {s.kind !== "open" ? <span className="ml-auto text-xs text-fg-subtle">{s.kind === "won" ? "Won" : "Lost"}</span> : null}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            {canArchive ? (
              <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(true)}>
                <Archive /> Archive
              </Button>
            ) : null}
            {canRestore ? (
              <Button variant="secondary" size="sm" onClick={() => restore.mutate(record.id)} loading={restore.isPending}>
                <RotateCcw /> Restore
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <DealMetrics
        deal={record}
        baseCurrency={baseCurrency}
        stages={stages}
        insights={insightsData}
        insightsPending={insights.isPending}
        canViewScores={canViewScores}
        canMove={canMove}
        busy={move.isPending}
        onSelectStage={(s) => move.requestMove(record, s)}
      />
      {!archived ? <QuickActions deal={record} /> : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <Tabs defaultValue="overview" className="min-w-0">
          <div className="-mx-1 overflow-x-auto px-1 pb-0.5">
            <TabsList className="w-max">
              {tabs.map((t) => (
                <TabsTrigger key={t.value} value={t.value}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {tabs.map((t) => (
            <TabsContent key={t.value} value={t.value}>
              {t.content}
            </TabsContent>
          ))}
        </Tabs>
        <aside className="flex flex-col gap-4">
          <Section title="Owner">
            {record.owner ? (
              <div className="flex items-center gap-2">
                <Avatar name={record.owner.display_name} size="sm" />
                <span className="truncate text-sm">{record.owner.display_name}</span>
              </div>
            ) : (
              <p className="text-sm text-fg-subtle">Unassigned</p>
            )}
          </Section>
          <Section title="Tags">
            <TagPicker entity="deal" recordId={record.id} current={record.tags} disabled={!editable} />
          </Section>
          <Section title="Key dates">
            <Facts
              items={[
                { label: "Stage since", value: formatDateTime(record.stage_entered_at) },
                { label: "Last activity", value: record.last_activity_at ? `${relativeDayLabel(record.last_activity_at)} · ${formatDate(record.last_activity_at)}` : "None yet" },
                {
                  label: "Next activity",
                  value: record.next_activity_at ? (
                    <span className={record.next_activity_title ? undefined : "text-fg-muted"} title={record.next_activity_title || undefined}>
                      {relativeDayLabel(record.next_activity_at)}
                      {record.next_activity_title ? ` · ${record.next_activity_title}` : ""}
                    </span>
                  ) : record.status === "open" ? (
                    <span className="text-danger">No next step</span>
                  ) : (
                    "—"
                  ),
                },
                { label: "Created", value: formatDateTime(record.created_at) },
                { label: "Updated", value: formatDateTime(record.updated_at) },
                ...(record.archived_at ? [{ label: "Archived", value: formatDateTime(record.archived_at) }] : []),
              ]}
            />
          </Section>
        </aside>
      </div>

      {move.dialog}
      <DealFormDialog open={editing} onOpenChange={setEditing} deal={record} pipelines={pipelines.data?.results ?? []} />
      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={`Archive ${record.name}?`}
        description="The deal disappears from the board and lists. You can restore it later."
        confirmLabel="Archive"
        destructive
        loading={archive.isPending}
        onConfirm={() => archive.mutate(record.id, { onSuccess: () => setConfirmArchive(false) })}
      />
    </div>
  );
}
