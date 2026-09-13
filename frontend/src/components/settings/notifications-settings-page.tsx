"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { getNotificationPreferences, updateNotificationPreferences } from "@/lib/api/crm";
import { NOTIFICATION_KINDS, NOTIFICATION_LABELS, type NotificationKind, type NotificationPreferences } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { hasPermission, useSession } from "@/lib/session";
import { humanize } from "@/lib/utils";

const MAX_INACTIVE_DAYS = 365;

function kindLabel(kind: NotificationKind): string {
  return NOTIFICATION_LABELS[kind] ?? humanize(kind);
}

export function NotificationsSettingsPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canView = hasPermission(active, "notifications.view");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const prefs = useQuery({ queryKey: crmKeys.notificationPreferences, queryFn: getNotificationPreferences, enabled: canView });

  const save = useMutation({
    mutationFn: (input: Partial<Pick<NotificationPreferences, "in_app" | "email" | "deal_inactive_days">>) => updateNotificationPreferences(input),
    onSuccess: (saved) => {
      queryClient.setQueryData(crmKeys.notificationPreferences, saved);
      toast({ tone: "success", title: "Preferences saved", durationMs: 2500 });
    },
    onError: (err) => {
      void queryClient.invalidateQueries({ queryKey: crmKeys.notificationPreferences });
      const description = isApiError(err) && err.isValidation ? err.summary() : errorMessage(err);
      toast({ tone: "error", title: "Could not save preferences", description });
    },
  });

  if (!canView) {
    return (
      <div>
        <PageHeader title="Notifications" />
        <EmptyState icon={<Bell />} title="No access" description="Your role does not include permission to manage notifications." />
      </div>
    );
  }

  const data = prefs.data;
  const kinds: NotificationKind[] = data?.kinds?.length ? data.kinds : [...NOTIFICATION_KINDS];

  const toggle = (channel: "in_app" | "email", kind: NotificationKind, checked: boolean) => {
    if (!data) return;
    const next = { ...data[channel], [kind]: checked };
    queryClient.setQueryData(crmKeys.notificationPreferences, { ...data, [channel]: next });
    save.mutate({ [channel]: next });
  };

  return (
    <div>
      <PageHeader title="Notifications" description="Choose what you are told about, and where. Changes are saved as you make them." />
      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Alerts</CardTitle>
            <CardDescription>In-app alerts appear in the bell menu; email alerts go to your sign-in address.</CardDescription>
          </CardHeader>
          <CardContent>
            {prefs.isPending ? (
              <SkeletonRows rows={5} />
            ) : prefs.isError ? (
              <EmptyState
                title="Could not load preferences"
                description={errorMessage(prefs.error)}
                action={
                  <Button variant="secondary" onClick={() => prefs.refetch()}>
                    Retry
                  </Button>
                }
                className="py-8"
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Event</TableHead>
                    <TableHead className="w-24 text-center">In-app</TableHead>
                    <TableHead className="w-24 text-center">Email</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {kinds.map((kind) => (
                    <TableRow key={kind}>
                      <TableCell className="font-medium">{kindLabel(kind)}</TableCell>
                      <TableCell className="text-center">
                        <Switch aria-label={`${kindLabel(kind)}: in-app`} checked={data?.in_app[kind] ?? false} onCheckedChange={(c) => toggle("in_app", kind, c)} />
                      </TableCell>
                      <TableCell className="text-center">
                        <Switch aria-label={`${kindLabel(kind)}: email`} checked={data?.email[kind] ?? false} onCheckedChange={(c) => toggle("email", kind, c)} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {data ? <InactivityCard value={data.deal_inactive_days} onSave={(days) => save.mutate({ deal_inactive_days: days })} saving={save.isPending} /> : null}
      </div>
    </div>
  );
}

function InactivityCard({ value, onSave, saving }: { value: number; onSave: (days: number) => void; saving: boolean }) {
  const [draft, setDraft] = React.useState(String(value));
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const days = Number(draft);
    if (!Number.isInteger(days) || days < 0 || days > MAX_INACTIVE_DAYS) {
      setError(`Enter a whole number between 0 and ${MAX_INACTIVE_DAYS}.`);
      return;
    }
    setError(null);
    if (days !== value) onSave(days);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Deal inactivity</CardTitle>
        <CardDescription>Warn when a deal you own has had no activity for a while. Set to 0 to turn the warning off.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            commit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="deal-inactive-days">Warn after (days)</Label>
            <Input
              id="deal-inactive-days"
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_INACTIVE_DAYS}
              className="w-32"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "deal-inactive-days-error" : "deal-inactive-days-help"}
            />
          </div>
          <Button type="submit" variant="secondary" loading={saving} disabled={draft === String(value)}>
            Save
          </Button>
          {error ? (
            <p id="deal-inactive-days-error" role="alert" className="w-full text-xs text-danger">
              {error}
            </p>
          ) : (
            <p id="deal-inactive-days-help" className="w-full text-xs text-fg-subtle">
              {value === 0 ? "Inactivity warnings are off." : `You will be warned after ${value} ${value === 1 ? "day" : "days"} without activity.`}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
