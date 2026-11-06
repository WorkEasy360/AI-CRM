"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Bell, Clock, KanbanSquare, ListTodo, MessageCircle, MoreHorizontal, Pencil, Plus, Trash2, Trophy, UserPlus, Users, Workflow, XCircle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import {
  ACTION_LABELS,
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
  MERGE_FIELDS,
  TRIGGER_LABELS,
  automationKeys,
  createAutomationRule,
  deleteAutomationRule,
  listAutomationRules,
  updateAutomationRule,
  type AutomationAction,
  type AutomationRule,
  type AutomationRuleInput,
  type AutomationTrigger,
} from "@/lib/api/automation";
import { listPipelines, listWhatsAppTemplates } from "@/lib/api/crm";
import type { WhatsAppTemplate } from "@/lib/api/crm-types";
import { crmKeys } from "@/lib/crm/keys";
import { errorMessage } from "@/lib/api/problem";
import { hasPermission, useSession } from "@/lib/session";
import { cn, formatDateTime } from "@/lib/utils";

/** Icon and tint per trigger; each icon colour is >= 3:1 on its tint. */
const TRIGGER_ICON: Record<AutomationTrigger, { icon: React.ComponentType<{ className?: string }>; tone: string }> = {
  contact_created: { icon: UserPlus, tone: "bg-brand-soft text-brand" },
  deal_created: { icon: ListTodo, tone: "bg-warning-soft text-warning" },
  deal_stage_entered: { icon: KanbanSquare, tone: "bg-accent-soft text-accent" },
  deal_won: { icon: Trophy, tone: "bg-warning-soft text-warning" },
  deal_lost: { icon: XCircle, tone: "bg-danger-soft text-danger" },
};

type RuleDraft = Required<Pick<AutomationRuleInput, "name" | "trigger" | "action" | "message" | "delay_days" | "only_if_no_reply">> & { blurb: string };

/** Ready-made rules from the WorkEasy360 automation screen. Ones that need a WhatsApp template or a stage open the editor. */
const TEMPLATES: RuleDraft[] = [
  { name: "New Lead Welcome (WhatsApp)", blurb: "Send auto WhatsApp message when a new lead is added.", trigger: "contact_created", action: "send_whatsapp", message: "", delay_days: 0, only_if_no_reply: false },
  { name: "Follow-up Reminder", blurb: "Create a task 2 days after lead creation.", trigger: "contact_created", action: "create_task", message: "Follow up with the new lead", delay_days: 2, only_if_no_reply: false },
  { name: "Proposal Follow-up", blurb: "Send WhatsApp reminder if no response in 3 days.", trigger: "deal_stage_entered", action: "send_whatsapp", message: "", delay_days: 3, only_if_no_reply: true },
  { name: "Deal Won Notification", blurb: "Notify team on deal won.", trigger: "deal_won", action: "notify_team", message: "Deal won!", delay_days: 0, only_if_no_reply: false },
];

function needsEditor(draft: RuleDraft): boolean {
  return draft.action === "send_whatsapp" || draft.trigger === "deal_stage_entered";
}

const ACTION_ICON: Record<AutomationAction, React.ComponentType<{ className?: string }>> = {
  create_task: ListTodo,
  notify_owner: Bell,
  notify_team: Users,
  send_whatsapp: MessageCircle,
};

const WHEN: Record<AutomationTrigger, string> = {
  contact_created: "When a new lead is added",
  deal_created: "When a deal is created",
  deal_stage_entered: "When a deal enters a stage",
  deal_won: "When a deal is won",
  deal_lost: "When a deal is lost",
};

function inDays(days: number): string {
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export function summary(rule: Pick<AutomationRule, "trigger" | "action" | "delay_days" | "only_if_no_reply"> & { stage_name?: string | null }): string {
  const days = rule.delay_days;
  const when = rule.trigger === "deal_stage_entered" && rule.stage_name ? `When a deal enters ${rule.stage_name}` : WHEN[rule.trigger];
  const waits = days > 0 && (rule.only_if_no_reply || rule.action !== "create_task");
  const what = rule.action === "create_task" ? (waits ? "create a task" : `create a task due ${days === 0 ? "the same day" : `in ${inDays(days)}`}`) : rule.action === "send_whatsapp" ? "send a WhatsApp message" : rule.action === "notify_team" ? "notify the team" : "notify the owner";
  if (!waits) return `${when}, ${what}.`;
  return rule.only_if_no_reply ? `${when}: if there is no reply in ${inDays(days)}, ${what}.` : `${when}, ${what} after ${inDays(days)}.`;
}

export function AutomationPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canView = hasPermission(active, "automation.view");
  const canManage = hasPermission(active, "automation.manage");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = React.useState<{ rule: AutomationRule } | { draft: RuleDraft | null } | null>(null);
  const [deleting, setDeleting] = React.useState<AutomationRule | null>(null);

  const rules = useQuery({ queryKey: automationKeys.rules, queryFn: listAutomationRules, enabled: canView });
  const toggle = useMutation({
    mutationFn: (rule: AutomationRule) => updateAutomationRule(rule.id, { is_enabled: !rule.is_enabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: automationKeys.rules }),
    onError: (err) => toast({ tone: "error", title: "Could not change the rule", description: errorMessage(err) }),
  });
  const remove = useMutation({
    mutationFn: (rule: AutomationRule) => deleteAutomationRule(rule.id),
    onSuccess: () => {
      setDeleting(null);
      queryClient.invalidateQueries({ queryKey: automationKeys.rules });
      toast({ tone: "success", title: "Automation deleted" });
    },
    onError: (err) => toast({ tone: "error", title: "Could not delete the rule", description: errorMessage(err) }),
  });

  if (!session) return null;
  if (!canView) return <EmptyState icon={<Workflow />} title="Automation is not part of your role" description="Ask a workspace administrator for access." />;
  const list = rules.data ?? [];

  return (
    <div className="w-full">
      <PageHeader
        title="Automation"
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setEditing({ draft: null })}>
              <Plus />
              Create Automation
            </Button>
          ) : null
        }
      />

      {rules.isError ? (
        <EmptyState title="Could not load automations" description={errorMessage(rules.error)} action={<Button variant="secondary" onClick={() => rules.refetch()}>Retry</Button>} />
      ) : !rules.data ? (
        <SkeletonRows rows={4} />
      ) : list.length === 0 ? (
        <section className="rounded-lg border border-border bg-surface p-4 shadow-sm">
          <EmptyState icon={<Workflow />} title="No automations yet" description={canManage ? "Start from a ready-made rule, or create your own." : "An administrator can set up automations here."} />
          {canManage ? (
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {TEMPLATES.map((t) => (
                <li key={t.name}>
                  <TemplateButton template={t} onCustomize={() => setEditing({ draft: t })} />
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface shadow-sm" aria-label="Automation rules">
          {list.map((rule) => {
            const { icon: Icon, tone } = TRIGGER_ICON[rule.trigger];
            const ActionIcon = ACTION_ICON[rule.action];
            return (
              <li key={rule.id} className="flex items-center gap-3 px-4 py-3">
                <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", tone)} aria-hidden>
                  <Icon className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-fg">{rule.name}</p>
                  <p className="truncate text-xs text-fg-muted">{rule.description || summary(rule)}</p>
                  <p className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-fg-subtle">
                    <ActionIcon className="size-3 shrink-0" aria-hidden />
                    <span className="truncate">
                      {rule.action === "send_whatsapp" && rule.whatsapp_template_name ? `${rule.whatsapp_template_name} · ` : ""}
                      {rule.run_count > 0 ? `Ran ${rule.run_count.toLocaleString()} ${rule.run_count === 1 ? "time" : "times"} · last ${formatDateTime(rule.last_run_at)}` : "Has not run yet"}
                    </span>
                    {rule.pending_runs > 0 ? (
                      <span className="inline-flex shrink-0 items-center gap-0.5">
                        · <Clock className="size-3" aria-hidden />
                        {rule.pending_runs.toLocaleString()} waiting
                      </span>
                    ) : null}
                  </p>
                  {rule.last_outcome === "skipped" && rule.last_detail ? <p className="truncate text-xs text-warning">Last run skipped: {rule.last_detail}</p> : null}
                </div>
                <Switch
                  checked={rule.is_enabled}
                  onCheckedChange={() => toggle.mutate(rule)}
                  disabled={!canManage || toggle.isPending}
                  aria-label={`${rule.is_enabled ? "Turn off" : "Turn on"} ${rule.name}`}
                />
                {canManage ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${rule.name}`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setEditing({ rule })}>
                        <Pencil />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setDeleting(rule)} className="text-danger">
                        <Trash2 />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {editing ? <RuleDialog rule={"rule" in editing ? editing.rule : null} draft={"draft" in editing ? editing.draft : null} onClose={() => setEditing(null)} /> : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? null : setDeleting(null))}
        title="Delete this automation?"
        description={deleting ? `"${deleting.name}" stops running, and its waiting steps are dropped. Tasks, notifications and messages it already created stay.` : undefined}
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}

function TemplateButton({ template, onCustomize }: { template: RuleDraft; onCustomize: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useMutation({
    mutationFn: () => {
      const { blurb, ...input } = template;
      return createAutomationRule({ ...input, description: blurb });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: automationKeys.rules });
      toast({ tone: "success", title: "Automation added", description: template.name });
    },
    onError: (err) => toast({ tone: "error", title: "Could not add the automation", description: errorMessage(err) }),
  });
  const { icon: Icon, tone } = TRIGGER_ICON[template.trigger];
  return (
    <button
      type="button"
      // A WhatsApp template or a pipeline stage has to be chosen first: open the editor for those.
      onClick={() => (needsEditor(template) ? onCustomize() : create.mutate())}
      disabled={create.isPending}
      className="flex w-full items-center gap-3 rounded-md border border-border px-3 py-2.5 text-left transition-colors hover:border-primary/50 hover:bg-primary-soft/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
    >
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", tone)} aria-hidden>
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-fg">{template.name}</span>
        <span className="block truncate text-xs text-fg-muted">{template.blurb}</span>
      </span>
    </button>
  );
}

function RuleDialog({ rule, draft, onClose }: { rule: AutomationRule | null; draft: RuleDraft | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: session } = useSession();
  const start = rule ?? draft;
  const [name, setName] = React.useState(start?.name ?? "");
  const [trigger, setTrigger] = React.useState<AutomationTrigger>(start?.trigger ?? "contact_created");
  const [action, setAction] = React.useState<AutomationAction>(start?.action ?? "create_task");
  const [message, setMessage] = React.useState(start?.message ?? "");
  const [delay, setDelay] = React.useState(String(start?.delay_days ?? 0));
  const [noReply, setNoReply] = React.useState(start?.only_if_no_reply ?? false);
  const [templateId, setTemplateId] = React.useState<string>(rule?.whatsapp_template_id ?? "");
  const [stageId, setStageId] = React.useState<string>(rule?.stage_id ?? "");
  const [description] = React.useState(rule?.description ?? draft?.blurb ?? "");
  const stageRule = trigger === "deal_stage_entered";
  const pipelines = useQuery({ queryKey: crmKeys.pipelines, queryFn: () => listPipelines(), enabled: stageRule, staleTime: 60_000 });
  const [params, setParams] = React.useState<string[]>(rule?.template_params ?? []);
  const [error, setError] = React.useState<string | null>(null);
  const id = React.useId();

  const whatsapp = action === "send_whatsapp";
  const canSeeTemplates = hasPermission(session?.active ?? null, "whatsapp.view");
  const templates = useQuery({
    queryKey: crmKeys.whatsappTemplates,
    queryFn: listWhatsAppTemplates,
    enabled: whatsapp && canSeeTemplates,
    staleTime: 60_000,
  });
  const templateList: WhatsAppTemplate[] = templates.data?.results ?? [];
  const template = templateList.find((t) => t.id === templateId) ?? null;

  const chooseTemplate = (value: string) => {
    setTemplateId(value);
    const count = templateList.find((t) => t.id === value)?.parameter_count ?? 0;
    // Keep what was typed; a new first value greets the contact by name.
    setParams((current) => Array.from({ length: count }, (_, i) => current[i] ?? (i === 0 ? "{{first_name}}" : "")));
  };

  const save = useMutation({
    mutationFn: () => {
      const input: AutomationRuleInput = {
        name: name.trim(),
        trigger,
        action,
        message: message.trim(),
        delay_days: Number(delay) || 0,
        only_if_no_reply: noReply,
        description,
        stage_id: stageRule ? stageId || null : null,
        ...(whatsapp ? { whatsapp_template_id: templateId || null, template_params: params.map((p) => p.trim()) } : {}),
      };
      return rule ? updateAutomationRule(rule.id, input) : createAutomationRule(input);
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: automationKeys.rules });
      toast({ tone: "success", title: rule ? "Automation updated" : "Automation created", description: saved.name });
      onClose();
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const delayLabel = noReply ? "Wait for a reply (days)" : action === "create_task" ? "Due after (days)" : "Wait before acting (days)";

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{rule ? "Edit automation" : "Create Automation"}</DialogTitle>
          <DialogDescription>Rules act as the record&apos;s owner and never do more than the owner may do.</DialogDescription>
        </DialogHeader>
        <form
          id={`${id}-form`}
          className="grid max-h-[65vh] gap-3 overflow-y-auto pr-1"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            if (!name.trim()) {
              setError("Name is required.");
              return;
            }
            if (stageRule && !stageId) {
              setError("Choose the stage the deal has to enter.");
              return;
            }
            if (whatsapp && !templateId) {
              setError("Choose the WhatsApp template to send.");
              return;
            }
            if (whatsapp && params.some((p) => !p.trim())) {
              setError("Fill in every template value.");
              return;
            }
            save.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-trigger`}>When</Label>
            <Select value={trigger} onValueChange={(v) => setTrigger(v as AutomationTrigger)}>
              <SelectTrigger id={`${id}-trigger`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTOMATION_TRIGGERS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TRIGGER_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {stageRule ? (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-stage`}>Stage</Label>
              <Select value={stageId} onValueChange={setStageId}>
                <SelectTrigger id={`${id}-stage`}>
                  <SelectValue placeholder={pipelines.isPending ? "Loading stages…" : "Choose a stage"} />
                </SelectTrigger>
                <SelectContent>
                  {(pipelines.data?.results ?? []).flatMap((p) =>
                    p.stages
                      .filter((s) => !s.archived_at)
                      .map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {(pipelines.data?.results.length ?? 0) > 1 ? `${p.name} · ${s.name}` : s.name}
                        </SelectItem>
                      )),
                  )}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-action`}>Then</Label>
            <Select value={action} onValueChange={(v) => setAction(v as AutomationAction)}>
              <SelectTrigger id={`${id}-action`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUTOMATION_ACTIONS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {ACTION_LABELS[a]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {whatsapp ? (
            <WhatsAppFields
              id={id}
              loading={canSeeTemplates && templates.isPending}
              canSeeTemplates={canSeeTemplates}
              templates={templateList}
              template={template}
              templateId={templateId}
              savedName={rule?.whatsapp_template_name ?? null}
              onTemplate={chooseTemplate}
              params={params}
              onParams={setParams}
            />
          ) : (
            <div className="grid gap-1.5">
              <Label htmlFor={`${id}-message`}>{action === "create_task" ? "Task title" : "Notification text"}</Label>
              <Input id={`${id}-message`} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={200} placeholder={name || "Defaults to the rule name"} />
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-delay`}>{delayLabel}</Label>
            <Input id={`${id}-delay`} type="number" min={0} max={90} value={delay} onChange={(e) => setDelay(e.target.value)} className="w-28" />
          </div>
          <label className="flex items-start gap-2 text-sm text-fg">
            <input type="checkbox" checked={noReply} onChange={(e) => setNoReply(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--kl-primary)]" />
            <span>
              Only if the contact has not replied
              <span className="block text-xs text-fg-muted">Skipped when the contact writes back on WhatsApp or by email during the wait.</span>
            </span>
          </label>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={`${id}-form`} disabled={save.isPending}>
            {rule ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WhatsAppFields({
  id,
  loading,
  canSeeTemplates,
  templates,
  template,
  templateId,
  savedName,
  onTemplate,
  params,
  onParams,
}: {
  id: string;
  loading: boolean;
  canSeeTemplates: boolean;
  templates: WhatsAppTemplate[];
  template: WhatsAppTemplate | null;
  templateId: string;
  savedName: string | null;
  onTemplate: (id: string) => void;
  params: string[];
  onParams: (params: string[]) => void;
}) {
  if (!canSeeTemplates) {
    return <p className="text-sm text-fg-muted">Your role cannot see the WhatsApp templates.{savedName ? ` This rule sends "${savedName}".` : ""}</p>;
  }
  if (loading) return <p className="text-sm text-fg-muted">Loading WhatsApp templates…</p>;
  if (templates.length === 0) {
    return (
      <p className="rounded-md border border-border px-3 py-2 text-sm text-fg-muted">
        No approved WhatsApp templates yet. Connect WhatsApp and add one in{" "}
        <Link href="/settings/whatsapp" className="font-medium text-primary hover:underline">
          Settings → WhatsApp
        </Link>
        .
      </p>
    );
  }
  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-template`}>WhatsApp template</Label>
        <Select value={templateId} onValueChange={onTemplate}>
          <SelectTrigger id={`${id}-template`}>
            <SelectValue placeholder="Choose an approved template" />
          </SelectTrigger>
          <SelectContent>
            {templates.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name} ({t.language})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {template?.body ? <p className="whitespace-pre-wrap rounded-md border border-border px-3 py-2 text-xs text-fg-muted">{template.body}</p> : null}
      </div>
      {params.map((value, i) => (
        <div key={i} className="grid gap-1.5">
          <Label htmlFor={`${id}-param-${i}`}>{`Value for {{${i + 1}}}`}</Label>
          <Input id={`${id}-param-${i}`} value={value} maxLength={200} onChange={(e) => onParams(params.map((p, j) => (j === i ? e.target.value : p)))} />
        </div>
      ))}
      {params.length > 0 ? <p className="text-xs text-fg-subtle">Merge fields: {MERGE_FIELDS.join(" ")}</p> : null}
      <p className="text-xs text-fg-subtle">Sent from the record owner, and only to contacts who have agreed to WhatsApp messages.</p>
    </>
  );
}
