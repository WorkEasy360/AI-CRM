"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRightLeft, Globe, Mail, Pencil, Phone, RotateCcw, Trash2 } from "lucide-react";
import { RecordActivities } from "@/components/activities/record-activities";
import { CustomFieldsSummary, useCustomFields } from "@/components/crm/custom-fields-form";
import { DealContactsSection } from "@/components/crm/deals/deal-contacts-section";
import { relativeDayLabel } from "@/components/crm/deals/deal-helpers";
import { DealLinesSection } from "@/components/crm/deals/deal-lines-section";
import { DealMetrics, StageTrack } from "@/components/crm/deals/deal-metrics";
import { DealSummaryCard } from "@/components/crm/deals/deal-summary-card";
import { useMoveStage, type StageTarget } from "@/components/crm/deals/move-stage-dialog";
import { StatusBadge } from "@/components/crm/pipeline/deals-list";
import { QuickActions } from "@/components/crm/quick-actions";
import { Facts, RecordPageError, RecordPageSkeleton, Section } from "@/components/crm/record-page";
import { TagPicker } from "@/components/crm/tag-picker";
import { useArchiveRestore } from "@/components/crm/use-record-mutations";
import dynamic from "next/dynamic";

// Everything below lives behind a tab or a button. Radix already unmounts the inactive tabs, so the
// only thing still paid for on arrival was their code; these load when the member opens the tab.
// The summary the page lands on (facts, metrics, stage track) stays in the route chunk.
const DealCommunication = dynamic(() => import("@/components/crm/deals/deal-communication").then((m) => m.DealCommunication), { ssr: false });
const DealFormDialog = dynamic(() => import("@/components/crm/deals/deal-form-dialog").then((m) => m.DealFormDialog), { ssr: false });
const DealHistorySection = dynamic(() => import("@/components/crm/deals/deal-history-section").then((m) => m.DealHistorySection), { ssr: false });
const DealInsightsPanel = dynamic(() => import("@/components/crm/deals/deal-insights-panel").then((m) => m.DealInsightsPanel), { ssr: false });
const FilesPanel = dynamic(() => import("@/components/crm/files-panel").then((m) => m.FilesPanel), { ssr: false });
const NotesPanel = dynamic(() => import("@/components/crm/notes-panel").then((m) => m.NotesPanel), { ssr: false });
const Timeline = dynamic(() => import("@/components/crm/timeline").then((m) => m.Timeline), { ssr: false });
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getCompany, getDeal, getDealInsights, listPipelines } from "@/lib/api/crm";
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
  // Only the id is needed, so insights leave together with the deal instead of one round trip after it
  // (the endpoint applies the same view scope and 404s exactly when the deal does).
  const insights = useQuery({ queryKey: crmKeys.dealInsights(id), queryFn: () => getDealInsights(id), staleTime: 60_000 });
  const companyId = deal.data?.company?.id ?? null;
  const company = useQuery({ queryKey: crmKeys.record("companies", companyId ?? ""), queryFn: () => getCompany(companyId as string), enabled: Boolean(companyId), staleTime: 60_000 });
  const { definitions } = useCustomFields("deal");
  const { archive, restore } = useArchiveRestore("deal", "delete");
  const move = useMoveStage();
  const [editing, setEditing] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  if (deal.isPending) return <RecordPageSkeleton />;
  if (deal.isError) return <RecordPageError error={deal.error} backHref={BACK.href} backLabel="Pipeline" />;
  const record = deal.data;
  const archived = Boolean(record.archived_at);
  const editable = !archived && canEditRecord(active, "deals", record.owner?.id);
  const canMove = !archived && can(active, "deals.change_stage");
  const canDelete = !archived && can(active, "deals.delete");
  const canRestore = archived && can(active, "deals.restore");
  const canViewScores = can(active, "ai.scores.view");
  const canUseCopilot = can(active, "ai.copilot.use");
  const showActivities = can(active, "activities.view");
  const showCommunication = can(active, "email.view") || can(active, "whatsapp.view");
  const showInsights = canViewScores || canUseCopilot;
  const showFiles = can(active, "files.view");
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
          <DealSummaryCard dealId={record.id} />
          <details open className="rounded-md border border-border bg-surface">
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold">Details</summary>
            <div className="flex flex-col gap-4 border-t border-border px-4 py-4">
              <Facts items={facts} />
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
    ...(showFiles ? [{ value: "files", label: "Files", content: <FilesPanel entity="deal" recordId={record.id} disabled={archived} /> }] : []),
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
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h1 className="truncate text-xl font-semibold tracking-tight">{record.name}</h1>
              <span className="text-lg font-semibold tabular-nums text-fg-muted">· {formatMoney(record.amount, record.currency)}</span>
              {archived ? <Badge variant="warning">Deleted</Badge> : null}
              <StatusBadge status={record.status} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
              <span className="inline-flex items-center gap-1.5">
                {record.owner ? <Avatar name={record.owner.display_name} size="sm" className="size-5 text-[10px]" /> : null}
                {record.owner ? record.owner.display_name : "Unassigned"}
              </span>
              <span>{record.pipeline.name}</span>
              <span>Closing {formatDate(record.expected_close_date)}</span>
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
            {canDelete ? (
              <Button variant="danger-ghost" size="sm" onClick={() => setConfirmDelete(true)}>
                <Trash2 /> Delete
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

      <StageTrack stages={stages} current={record.stage} status={record.status} canMove={canMove} busy={move.isPending} onSelect={(s) => move.requestMove(record, s)} />

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

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="flex flex-col gap-4 xl:order-first">
          <Section title="Related contact">
            {record.primary_contact ? (
              <div className="flex flex-col gap-1.5">
                <Link href={`/contacts/${enc(record.primary_contact.id)}`} className="flex items-center gap-2 hover:text-primary">
                  <Avatar name={record.primary_contact.name} size="sm" />
                  <span className="truncate text-sm font-medium">{record.primary_contact.name}</span>
                </Link>
                {record.primary_contact.email ? (
                  <a href={`mailto:${record.primary_contact.email}`} className="inline-flex min-w-0 items-center gap-1.5 text-sm text-fg-muted hover:text-primary">
                    <Mail className="size-3.5 shrink-0" aria-hidden /> <span className="truncate">{record.primary_contact.email}</span>
                  </a>
                ) : null}
                {record.primary_contact.phone ? (
                  <a href={`tel:${record.primary_contact.phone}`} className="inline-flex min-w-0 items-center gap-1.5 text-sm text-fg-muted hover:text-primary">
                    <Phone className="size-3.5 shrink-0" aria-hidden /> <span className="truncate">{record.primary_contact.phone}</span>
                  </a>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-fg-subtle">No primary contact. Link one so the deal has someone to chase.</p>
            )}
          </Section>
          <Section title="Related company">
            {record.company ? (
              <div className="flex flex-col gap-1.5">
                <Link href={`/companies/${enc(record.company.id)}`} className="flex items-center gap-2 hover:text-primary">
                  <Avatar name={record.company.name} size="sm" />
                  <span className="truncate text-sm font-medium">{record.company.name}</span>
                </Link>
                {company.data?.website ? (
                  <a href={company.data.website} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1.5 text-sm text-fg-muted hover:text-primary">
                    <Globe className="size-3.5 shrink-0" aria-hidden /> <span className="truncate">{company.data.website}</span>
                  </a>
                ) : null}
                {company.data?.phone ? (
                  <a href={`tel:${company.data.phone}`} className="inline-flex min-w-0 items-center gap-1.5 text-sm text-fg-muted hover:text-primary">
                    <Phone className="size-3.5 shrink-0" aria-hidden /> <span className="truncate">{company.data.phone}</span>
                  </a>
                ) : null}
              </div>
            ) : (
              <p className="text-sm text-fg-subtle">No company linked.</p>
            )}
          </Section>
          <Section title="Tags">
            <TagPicker entity="deal" recordId={record.id} current={record.tags} disabled={!editable} />
          </Section>
          <Section title="Description">
            {record.description ? (
              <p className="whitespace-pre-wrap break-words text-sm">{record.description}</p>
            ) : (
              <p className="text-sm text-fg-subtle">No description yet.</p>
            )}
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
                ...(record.archived_at ? [{ label: "Deleted", value: formatDateTime(record.archived_at) }] : []),
              ]}
            />
          </Section>
        </aside>
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
      </div>

      {move.dialog}
      <DealFormDialog open={editing} onOpenChange={setEditing} deal={record} pipelines={pipelines.data?.results ?? []} />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${record.name}?`}
        description="The deal disappears from the board and lists. Nothing is erased: a manager can restore it."
        confirmLabel="Delete"
        destructive
        loading={archive.isPending}
        onConfirm={() => archive.mutate(record.id, { onSuccess: () => setConfirmDelete(false) })}
      />
    </div>
  );
}
