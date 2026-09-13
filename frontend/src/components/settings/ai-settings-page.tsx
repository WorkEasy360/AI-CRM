"use client";

import { useQuery } from "@tanstack/react-query";
import { Bot, ShieldAlert } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getAIUsage } from "@/lib/api/crm";
import type { AIUsage } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { formatMoney } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { hasPermission, useSession } from "@/lib/session";
import { cn, formatDateTime, humanize } from "@/lib/utils";

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export function formatCompact(value: number): string {
  return compact.format(value);
}

export function AISettingsPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canManage = hasPermission(active, "ai.settings.manage");
  const usage = useQuery({ queryKey: crmKeys.aiUsage, queryFn: getAIUsage, enabled: canManage, staleTime: 60_000 });

  if (!canManage) {
    return (
      <div>
        <PageHeader title="AI assistant" />
        <EmptyState icon={<Bot />} title="No access" description="Your role does not include permission to manage AI settings." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="AI assistant" description="Usage, limits and how the assistant is allowed to help." />
      {usage.isPending ? (
        <SkeletonRows rows={4} />
      ) : usage.isError ? (
        <EmptyState
          title="Could not load AI usage"
          description={errorMessage(usage.error)}
          action={
            <Button variant="secondary" onClick={() => usage.refetch()}>
              Retry
            </Button>
          }
        />
      ) : (
        <div className="grid gap-6">
          <UsageTiles usage={usage.data} />
          <div className="grid gap-6 lg:grid-cols-2">
            <ByFeature rows={usage.data.by_feature} />
            <ByMember rows={usage.data.by_member} />
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <ModelsCard limits={usage.data.limits} />
            <HowItWorksCard />
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-md border border-border bg-surface px-4 py-3">
      <p className="text-xs text-fg-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-tight text-fg">{value}</p>
      {detail ? <p className="mt-0.5 text-xs text-fg-subtle">{detail}</p> : null}
    </div>
  );
}

function UsageTiles({ usage }: { usage: AIUsage }) {
  const tokens = usage.input_tokens + usage.output_tokens;
  const limit = usage.limits.org_tokens_per_day;
  const ratio = limit > 0 ? Math.min(usage.tokens_today / limit, 1) : 0;
  const percent = Math.round(ratio * 100);
  const severity = ratio >= 1 ? "bg-danger" : ratio >= 0.8 ? "bg-warning" : "bg-primary";
  return (
    <section aria-label="Usage summary" className="grid gap-4">
      <p className="text-xs text-fg-subtle">Since {formatDateTime(usage.since)}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Requests" value={formatCompact(usage.requests)} detail={usage.flagged_inputs > 0 ? `${usage.flagged_inputs.toLocaleString()} with flagged input` : undefined} />
        <Tile label="Tokens" value={formatCompact(tokens)} detail={`${formatCompact(usage.input_tokens)} in · ${formatCompact(usage.output_tokens)} out · ${formatCompact(usage.cache_read_tokens)} cached`} />
        <Tile label="Estimated cost" value={formatMoney(usage.estimated_cost_usd, "USD")} detail="Approximate, based on list prices" />
        <div className="rounded-md border border-border bg-surface px-4 py-3">
          <p className="text-xs text-fg-muted">Tokens today</p>
          <p className="mt-1 text-xl font-semibold tracking-tight text-fg">
            {formatCompact(usage.tokens_today)} <span className="text-sm font-normal text-fg-subtle">/ {limit > 0 ? formatCompact(limit) : "no limit"}</span>
          </p>
          {limit > 0 ? (
            <div
              role="progressbar"
              aria-label="Share of today's token limit used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={`${percent}% of ${formatCompact(limit)} tokens`}
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-primary-soft"
            >
              <div className={cn("h-full rounded-full", severity)} style={{ width: `${percent}%` }} />
            </div>
          ) : null}
          <p className="mt-0.5 text-xs text-fg-subtle">{limit > 0 ? `${percent}% of the daily workspace limit` : "No daily workspace limit configured"}</p>
        </div>
      </div>
    </section>
  );
}

function ByFeature({ rows }: { rows: AIUsage["by_feature"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>By feature</CardTitle>
        <CardDescription>Which assistants your team uses most.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-fg-muted">No AI requests yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Feature</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.feature}>
                  <TableCell>{humanize(r.feature)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.requests.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.cost, "USD")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ByMember({ rows }: { rows: AIUsage["by_member"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>By member</CardTitle>
        <CardDescription>Requests are limited per person per hour.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-fg-muted">No AI requests yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead className="text-right">Requests</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.membership_id}>
                  <TableCell>{r.display_name}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.requests.toLocaleString()}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.cost, "USD")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ModelsCard({ limits }: { limits: AIUsage["limits"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Models and limits</CardTitle>
        <CardDescription>Configured by your administrator in the server settings.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-fg-subtle">Fast model (drafts, rewrites)</dt>
            <dd className="font-mono text-xs">{limits.model_fast || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-subtle">Strong model (summaries)</dt>
            <dd className="font-mono text-xs">{limits.model_strong || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-subtle">Requests per member per hour</dt>
            <dd>{limits.user_requests_per_hour > 0 ? limits.user_requests_per_hour.toLocaleString() : "Unlimited"}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-subtle">Tokens per workspace per day</dt>
            <dd>{limits.org_tokens_per_day > 0 ? limits.org_tokens_per_day.toLocaleString() : "Unlimited"}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

function HowItWorksCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="size-4 text-primary" aria-hidden /> How AI is used
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 text-sm text-fg-muted">
          <li>The assistant only writes drafts: emails, WhatsApp follow-ups and deal summaries. A person reviews and sends every message.</li>
          <li>Drafts are built from CRM data the member can already see. Notes that look like instructions to the assistant are ignored and counted as flagged input.</li>
          <li>Lead scores and deal risk are rules-based calculations, not AI predictions, and are labelled as such in the app.</li>
          <li>Messages sent from an AI draft are marked “AI-assisted” in the record history.</li>
        </ul>
      </CardContent>
    </Card>
  );
}
