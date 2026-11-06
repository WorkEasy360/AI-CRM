"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CreditCard, Info, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import {
  billingKeys,
  cancelAddon,
  changePlan,
  getEditionCatalog,
  getSubscription,
  getUsage,
  listAddonPurchases,
  purchaseAddon,
  type BillingCycle,
  type Edition,
  type Subscription,
  type UsageMetric,
} from "@/lib/api/billing";
import { errorMessage } from "@/lib/api/problem";
import { hasPermission, useSession } from "@/lib/session";
import { cn, formatDate } from "@/lib/utils";

const KEY_LIMITS = ["users", "records", "pipelines", "automation_rules", "custom_fields", "ai_credits"] as const;

function formatAmount(value: number, unit: string): string {
  if (unit === "bytes") {
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(value % 1024 ** 3 ? 1 : 0)} GB`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(0)} MB`;
    return `${value.toLocaleString()} B`;
  }
  return value.toLocaleString();
}

function formatLimit(limit: number | null, unit = "count"): string {
  if (limit === null) return "Unlimited";
  if (limit === 0) return "Not included";
  return formatAmount(limit, unit);
}

function price(cents: number): string {
  return cents === 0 ? "$0" : `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
}

function daysLeft(iso: string | null): number | null {
  if (!iso) return null;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

export function BillingPage() {
  const { data: session } = useSession();
  const canBill = hasPermission(session?.active, "org.billing");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [cycle, setCycle] = React.useState<BillingCycle>("annual");

  const catalog = useQuery({ queryKey: billingKeys.catalog, queryFn: getEditionCatalog, staleTime: 5 * 60_000 });
  const subscription = useQuery({ queryKey: billingKeys.subscription, queryFn: getSubscription });
  const usage = useQuery({ queryKey: billingKeys.usage, queryFn: getUsage });
  const addons = useQuery({ queryKey: billingKeys.addons, queryFn: listAddonPurchases });

  React.useEffect(() => {
    if (subscription.data) setCycle(subscription.data.billing_cycle);
  }, [subscription.data]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["billing"] });
  const onError = (title: string) => (err: unknown) => toast({ tone: "error", title, description: errorMessage(err) });

  const planMutation = useMutation({
    mutationFn: changePlan,
    onSuccess: async (sub) => {
      await refresh();
      toast({ tone: "success", title: `You're on ${sub.edition.name}` });
    },
    onError: onError("Could not change plan"),
  });
  const buyMutation = useMutation({
    mutationFn: (key: string) => purchaseAddon(key),
    onSuccess: async () => {
      await refresh();
      toast({ tone: "success", title: "Add-on active", description: "Your new limit applies immediately." });
    },
    onError: onError("Could not add the add-on"),
  });
  const cancelMutation = useMutation({
    mutationFn: cancelAddon,
    onSuccess: refresh,
    onError: onError("Could not cancel the add-on"),
  });

  if (catalog.isLoading || subscription.isLoading || usage.isLoading) {
    return (
      <div>
        <PageHeader title="Plan & usage" />
        <SkeletonRows rows={6} />
      </div>
    );
  }
  const sub = subscription.data;
  const editions = catalog.data?.editions ?? [];
  const featureLabel = new Map((catalog.data?.features ?? []).map((f) => [f.key, f.label]));
  const selfService = Boolean(sub?.self_service && canBill);

  return (
    <div className="space-y-4">
      <PageHeader title="Plan & usage" description="Your plan, what you're using against its limits, and how to raise them." />

      {sub ? <CurrentPlan sub={sub} /> : null}

      <section aria-labelledby="usage-heading">
        <h2 id="usage-heading" className="mb-2 text-sm font-semibold text-fg">
          Usage
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {usage.data?.metrics.map((m) => (
            <UsageMeter key={m.key} metric={m} definition={m.key === "records" ? usage.data?.record_definition : undefined} />
          ))}
        </div>
      </section>

      <section aria-labelledby="plans-heading">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 id="plans-heading" className="text-sm font-semibold text-fg">
            Plans
          </h2>
          <div role="radiogroup" aria-label="Billing cycle" className="inline-flex rounded-sm border border-border p-0.5">
            {(["monthly", "annual"] as const).map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={cycle === c}
                onClick={() => setCycle(c)}
                className={cn(
                  "rounded-sm px-3 py-1 text-xs font-medium",
                  cycle === c ? "bg-brand text-brand-fg" : "text-fg-muted hover:text-fg",
                )}
              >
                {c === "monthly" ? "Monthly" : "Annual (save up to 22%)"}
              </button>
            ))}
          </div>
        </div>
        {!sub?.self_service ? (
          <p className="mb-2 flex items-center gap-1.5 text-xs text-fg-muted">
            <Info className="size-3.5" aria-hidden /> Plan changes for this workspace are handled by our billing team.
          </p>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {editions.map((e) => (
            <PlanCard
              key={e.key}
              edition={e}
              cycle={cycle}
              sub={sub}
              featureLabel={featureLabel}
              canChange={selfService}
              busy={planMutation.isPending}
              onChoose={(seats) => planMutation.mutate({ edition: e.key, billing_cycle: cycle, seats })}
            />
          ))}
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Add-ons</CardTitle>
          <CardDescription>Raise one limit without changing plan. Available on paid plans; limits rise immediately.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {catalog.data?.addons.map((a) => {
            const active = (addons.data?.results ?? []).filter((p) => p.addon === a.key && p.status === "active");
            return (
              <div key={a.key} className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-border px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg">{a.label}</p>
                  <p className="text-xs text-fg-muted">
                    {price(a.price_cents)} {a.recurring ? "/ month" : "one-off"}
                    {active.length ? ` · ${active.reduce((n, p) => n + p.quantity, 0)} active` : ""}
                  </p>
                </div>
                <div className="flex gap-2">
                  {active.length && selfService ? (
                    <Button size="sm" variant="ghost" loading={cancelMutation.isPending} onClick={() => cancelMutation.mutate(active[0]!.id)}>
                      Remove one
                    </Button>
                  ) : null}
                  <Button size="sm" variant="secondary" disabled={!selfService} loading={buyMutation.isPending} onClick={() => buyMutation.mutate(a.key)}>
                    Add
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

function CurrentPlan({ sub }: { sub: Subscription }) {
  const left = sub.status === "trialing" ? daysLeft(sub.trial_ends_at) : null;
  const lapsed = sub.edition.key !== sub.subscribed_edition;
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-full bg-primary-soft text-primary">
            <CreditCard className="size-5" aria-hidden />
          </div>
          <div>
            <p className="text-sm text-fg-muted">Current plan</p>
            <p className="text-lg font-semibold text-fg">
              {sub.edition.name}{" "}
              {sub.grandfathered ? (
                <Badge variant="primary">Legacy · full access</Badge>
              ) : sub.status === "trialing" && !lapsed ? (
                <Badge variant="warning">Trial · {left} day{left === 1 ? "" : "s"} left</Badge>
              ) : sub.status === "past_due" ? (
                <Badge variant="danger">Payment due</Badge>
              ) : lapsed ? (
                <Badge variant="neutral">Trial ended</Badge>
              ) : (
                <Badge variant="success">Active</Badge>
              )}
            </p>
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-4 text-sm">
          <div>
            <dt className="text-xs text-fg-muted">Billing</dt>
            <dd className="font-medium capitalize text-fg">{sub.billing_cycle}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">User licences</dt>
            <dd className="font-medium text-fg">{sub.seat_limit === null ? "Unlimited" : sub.seat_limit}</dd>
          </div>
          <div>
            <dt className="text-xs text-fg-muted">Renews</dt>
            <dd className="font-medium text-fg">{sub.current_period_end ? formatDate(sub.current_period_end) : "—"}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

const BAR: Record<string, string> = {
  ok: "bg-primary",
  warning: "bg-warning",
  at_limit: "bg-danger",
  unlimited: "bg-primary",
  not_included: "bg-border-strong",
};

const MODULE_LABELS: Record<string, string> = { contact: "Contacts", company: "Companies", deal: "Deals", product: "Products" };

function moduleLabel(module: string): string {
  return MODULE_LABELS[module] ?? module.charAt(0).toUpperCase() + module.slice(1);
}

function UsageMeter({ metric, definition }: { metric: UsageMetric; definition?: string }) {
  const pct = metric.limit ? Math.min(100, Math.round((metric.used / metric.limit) * 100)) : metric.limit === null ? 0 : 100;
  const period = metric.period === "monthly" ? " this month" : metric.period === "daily" ? " today" : "";
  return (
    <div className="rounded-sm border border-border bg-surface p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-fg">{metric.label}</p>
        <p className="text-xs text-fg-muted">
          {formatAmount(metric.used, metric.unit)} / {formatLimit(metric.limit, metric.unit)}
          {period}
        </p>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-subtle"
        role="progressbar"
        aria-label={`${metric.label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className={cn("h-full rounded-full", BAR[metric.state])} style={{ width: `${pct}%` }} />
      </div>
      {metric.modules?.length ? (
        <ul aria-label={`${metric.label} by module`} className="mt-2 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-fg-muted">
          {metric.modules.map((m) => (
            <li key={m.module} className="flex justify-between gap-2">
              <span>{moduleLabel(m.module)}</span>
              <span className="font-medium tabular-nums text-fg">{m.used.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {definition ? <p className="mt-1.5 text-xs text-fg-subtle">{definition}</p> : null}
      {(metric.state === "at_limit" || metric.state === "warning" || metric.state === "not_included") && metric.upgrade_edition ? (
        <p className="mt-1.5 flex items-center gap-1 text-xs font-medium text-primary">
          <Sparkles className="size-3.5" aria-hidden /> {metric.upgrade_edition.name} raises this limit
          {metric.addon ? " — or add an add-on" : ""}.
        </p>
      ) : null}
      {metric.addon_amount ? <p className="mt-1 text-xs text-fg-muted">Includes {formatAmount(metric.addon_amount, metric.unit)} from add-ons.</p> : null}
    </div>
  );
}

function PlanCard({
  edition,
  cycle,
  sub,
  featureLabel,
  canChange,
  busy,
  onChoose,
}: {
  edition: Edition;
  cycle: BillingCycle;
  sub: Subscription | undefined;
  featureLabel: Map<string, string>;
  canChange: boolean;
  busy: boolean;
  onChoose: (seats?: number) => void;
}) {
  const current = sub?.edition.key === edition.key && sub.status !== "trialing" && !sub.grandfathered;
  const cents = cycle === "annual" ? edition.price_annual_cents : edition.price_monthly_cents;
  const [seats, setSeats] = React.useState(String(Math.max(1, sub?.seats || 1)));
  const highlights = edition.features.filter((f) => f !== "data_backup").slice(-4);
  return (
    <Card className={cn("flex flex-col", edition.key === "premier" && "border-primary")}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{edition.name}</CardTitle>
          {edition.key === "premier" ? <Badge variant="primary">Most popular</Badge> : null}
        </div>
        <CardDescription>{edition.tagline}</CardDescription>
        <p className="pt-1 text-2xl font-semibold text-fg">
          {price(cents)}
          <span className="text-xs font-normal text-fg-muted"> /user/month{cycle === "annual" && cents ? ", billed annually" : ""}</span>
        </p>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <ul className="space-y-1 text-xs text-fg-muted">
          {KEY_LIMITS.map((k) => (
            <li key={k} className="flex justify-between gap-2">
              <span>{k === "custom_fields" ? "Custom fields / module" : k.replace("_", " ").replace(/^\w/, (c) => c.toUpperCase())}</span>
              <span className="font-medium text-fg">{formatLimit(edition.limits[k] ?? null)}</span>
            </li>
          ))}
        </ul>
        {highlights.length ? (
          <ul className="space-y-1 text-xs text-fg">
            {highlights.map((f) => (
              <li key={f} className="flex items-center gap-1.5">
                <Check className="size-3.5 text-primary" aria-hidden /> {featureLabel.get(f) ?? f}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-auto space-y-2">
          {edition.key !== "free" && canChange && !current ? (
            <div className="flex items-center gap-2">
              <Label htmlFor={`seats-${edition.key}`} className="text-xs">
                Licences
              </Label>
              <Input
                id={`seats-${edition.key}`}
                type="number"
                min={1}
                className="h-8 w-20"
                value={seats}
                onChange={(e) => setSeats(e.target.value)}
              />
            </div>
          ) : null}
          <Button
            className="w-full"
            variant={current ? "secondary" : edition.key === "premier" ? "primary" : "secondary"}
            disabled={current || !canChange}
            loading={busy}
            onClick={() => onChoose(edition.key === "free" ? undefined : Number(seats) || 1)}
          >
            {current ? "Current plan" : `Choose ${edition.name}`}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
