"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Archive, ArrowDown, ArrowUp, Check, GripVertical, KanbanSquare, MoreHorizontal, Pencil, Plus, Star, X } from "lucide-react";
import { z } from "zod";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { addStage, archivePipeline, archiveStage, createPipeline, listPipelines, reorderStages, updatePipeline, updateStage } from "@/lib/api/crm";
import type { Pipeline, PipelineStage, StageInput, StageKind } from "@/lib/api/crm-types";
import { TAG_COLORS } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { colorClasses, stageDotClass } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";

const KINDS: { value: StageKind; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

const pipelineSchema = z.object({ name: z.string().trim().min(1, "Pipeline name is required.").max(80, "Pipeline name is too long.") });
type PipelineFormValues = z.infer<typeof pipelineSchema>;

const stageSchema = z.object({
  name: z.string().trim().min(1, "Stage name is required.").max(80, "Stage name is too long."),
  kind: z.enum(["open", "won", "lost"]),
  default_probability: z
    .string()
    .trim()
    .refine((v) => /^\d{1,3}$/.test(v) && Number(v) <= 100, "Enter a whole number from 0 to 100."),
  color_token: z.string(),
  description: z.string().max(255, "Description is too long."),
});
type StageFormValues = z.infer<typeof stageSchema>;

function toStageInput(values: StageFormValues): StageInput {
  return {
    name: values.name,
    kind: values.kind,
    default_probability: Number(values.default_probability),
    color_token: values.color_token,
    description: values.description,
  };
}

function activeStages(pipeline: Pipeline): PipelineStage[] {
  return pipeline.stages.filter((s) => !s.archived_at).sort((a, b) => a.position - b.position);
}

export function PipelinesPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canManage = can(active, "pipelines.manage");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const pipelines = useQuery({ queryKey: crmKeys.pipelines, queryFn: () => listPipelines() });
  const list = React.useMemo(() => pipelines.data?.results ?? [], [pipelines.data]);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const selected = list.find((p) => p.id === selectedId) ?? list.find((p) => p.is_default) ?? list[0] ?? null;
  const [editing, setEditing] = React.useState<Pipeline | "new" | null>(null);
  const [archiving, setArchiving] = React.useState<Pipeline | null>(null);

  const invalidate = () => Promise.all([queryClient.invalidateQueries({ queryKey: crmKeys.pipelines }), queryClient.invalidateQueries({ queryKey: ["crm", "deals", "board"] })]);

  const makeDefault = useMutation({
    mutationFn: (p: Pipeline) => updatePipeline(p.id, { is_default: true, version: p.version }),
    onSuccess: async (saved) => {
      await invalidate();
      toast({ tone: "success", title: "Default pipeline updated", description: saved.name });
    },
    onError: (err) => toast({ tone: "error", title: "Could not update pipeline", description: errorMessage(err) }),
  });
  const archive = useMutation({
    mutationFn: (p: Pipeline) => archivePipeline(p.id),
    onSuccess: async () => {
      await invalidate();
      toast({ tone: "success", title: "Pipeline archived" });
      setArchiving(null);
    },
    onError: (err) => {
      setArchiving(null);
      toast({
        tone: "error",
        title: "Could not archive pipeline",
        description: isApiError(err) && err.status === 409 ? "Make another pipeline the default and close or move its open deals first." : errorMessage(err),
      });
    },
  });

  return (
    <div>
      <PageHeader
        title="Pipelines"
        description="Define the stages deals move through. Every pipeline needs at least one won and one lost stage."
        actions={
          canManage ? (
            <Button onClick={() => setEditing("new")}>
              <Plus /> New pipeline
            </Button>
          ) : null
        }
      />

      {pipelines.isPending ? (
        <SkeletonRows rows={3} />
      ) : pipelines.isError ? (
        <EmptyState title="Could not load pipelines" description={errorMessage(pipelines.error)} action={<Button variant="secondary" onClick={() => pipelines.refetch()}>Retry</Button>} />
      ) : list.length === 0 ? (
        <EmptyState
          icon={<KanbanSquare />}
          title="No pipelines yet"
          description="Create your first pipeline; it starts with a sensible set of stages you can adjust."
          action={canManage ? <Button onClick={() => setEditing("new")}>Create a pipeline</Button> : null}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <ul className="flex flex-col gap-2" aria-label="Pipelines">
            {list.map((p) => {
              const isSelected = selected?.id === p.id;
              return (
                <li key={p.id}>
                  <Card className={cn("transition-colors", isSelected && "border-primary")}>
                    <CardContent className="flex items-start gap-2 px-4 py-3">
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelectedId(p.id)} aria-pressed={isSelected}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-semibold">{p.name}</span>
                          {p.is_default ? <Badge variant="primary">Default</Badge> : null}
                        </div>
                        <p className="mt-0.5 text-xs text-fg-subtle">
                          {activeStages(p).length} {activeStages(p).length === 1 ? "stage" : "stages"}
                        </p>
                      </button>
                      {canManage ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${p.name}`}>
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setEditing(p)}>
                              <Pencil /> Rename
                            </DropdownMenuItem>
                            {!p.is_default ? (
                              <DropdownMenuItem onSelect={() => makeDefault.mutate(p)}>
                                <Star /> Make default
                              </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem destructive disabled={p.is_default} onSelect={() => setArchiving(p)}>
                              <Archive /> Archive
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
          {selected ? <StageEditor key={selected.id} pipeline={selected} canManage={canManage} /> : null}
        </div>
      )}

      <PipelineDialog pipeline={editing} onOpenChange={(open) => !open && setEditing(null)} onCreated={(p) => setSelectedId(p.id)} />
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={`Archive ${archiving?.name ?? "pipeline"}?`}
        description="Archived pipelines are hidden from the board. Pipelines with open deals or set as default cannot be archived."
        confirmLabel="Archive pipeline"
        destructive
        loading={archive.isPending}
        onConfirm={() => archiving && archive.mutate(archiving)}
      />
    </div>
  );
}

function PipelineDialog({ pipeline, onOpenChange, onCreated }: { pipeline: Pipeline | "new" | null; onOpenChange: (open: boolean) => void; onCreated: (p: Pipeline) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const isNew = pipeline === "new";
  const existing = pipeline && pipeline !== "new" ? pipeline : null;
  const form = useForm<PipelineFormValues>({ resolver: zodResolver(pipelineSchema), defaultValues: { name: "" } });

  React.useEffect(() => {
    if (pipeline) {
      form.reset({ name: existing?.name ?? "" });
      setFieldErrors({});
    }
  }, [pipeline, existing, form]);

  const mutation = useMutation({
    mutationFn: (values: PipelineFormValues) => (existing ? updatePipeline(existing.id, { name: values.name, version: existing.version }) : createPipeline({ name: values.name })),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: crmKeys.pipelines });
      toast({ tone: "success", title: isNew ? "Pipeline created" : "Pipeline renamed", description: saved.name });
      if (isNew) onCreated(saved);
      onOpenChange(false);
    },
    onError: (err) => {
      if (isApiError(err) && err.isValidation) setFieldErrors(err.fieldErrors());
      else if (isApiError(err) && err.status === 409) setFieldErrors({ non_field_errors: "This pipeline changed in the meantime. Close the dialog and try again." });
      else toast({ tone: "error", title: "Could not save pipeline", description: errorMessage(err) });
    },
  });

  return (
    <Dialog open={pipeline !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{isNew ? "New pipeline" : "Rename pipeline"}</DialogTitle>
            <DialogDescription>{isNew ? "New pipelines start with default stages you can edit afterwards." : "Deals keep their stages; only the name changes."}</DialogDescription>
          </DialogHeader>
          <FormError message={fieldErrors.non_field_errors} />
          <FormField control={form.control} name="name" label="Pipeline name" serverError={fieldErrors.name}>
            {(field) => <Input {...field} autoFocus maxLength={80} placeholder="Sales" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {isNew ? "Create pipeline" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ stage editor */

function StageEditor({ pipeline, canManage }: { pipeline: Pipeline; canManage: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const serverStages = React.useMemo(() => activeStages(pipeline), [pipeline]);
  const [order, setOrder] = React.useState<string[] | null>(null);
  const [editingId, setEditingId] = React.useState<string | "new" | null>(null);
  const [archiving, setArchiving] = React.useState<PipelineStage | null>(null);
  const [dragId, setDragId] = React.useState<string | null>(null);
  const [overId, setOverId] = React.useState<string | null>(null);

  const stages = React.useMemo(() => {
    if (!order) return serverStages;
    const byId = new Map(serverStages.map((s) => [s.id, s]));
    const ordered = order.map((id) => byId.get(id)).filter((s): s is PipelineStage => Boolean(s));
    const missing = serverStages.filter((s) => !order.includes(s.id));
    return [...ordered, ...missing];
  }, [order, serverStages]);

  const invalidate = () => Promise.all([queryClient.invalidateQueries({ queryKey: crmKeys.pipelines }), queryClient.invalidateQueries({ queryKey: ["crm", "deals", "board"] })]);

  const reorder = useMutation({
    mutationFn: (ids: string[]) => reorderStages(pipeline.id, ids),
    onSuccess: async () => {
      await invalidate();
      setOrder(null);
    },
    onError: (err) => {
      setOrder(null);
      toast({ tone: "error", title: "Could not reorder stages", description: errorMessage(err) });
    },
  });
  const archive = useMutation({
    mutationFn: (s: PipelineStage) => archiveStage(s.id),
    onSuccess: async () => {
      await invalidate();
      setArchiving(null);
      toast({ tone: "success", title: "Stage archived" });
    },
    onError: (err) => {
      setArchiving(null);
      toast({
        tone: "error",
        title: "Could not archive stage",
        description: isApiError(err) && err.status === 409 ? "Move the deals out of this stage first." : errorMessage(err),
      });
    },
  });

  const commitOrder = (ids: string[]) => {
    setOrder(ids);
    reorder.mutate(ids);
  };
  const moveBy = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= stages.length) return;
    const ids = stages.map((s) => s.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(target, 0, moved!);
    commitOrder(ids);
  };
  const dropOn = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = stages.map((s) => s.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragId);
    commitOrder(ids);
  };

  const kindsPresent = new Set(stages.map((s) => s.kind));
  const warning = !kindsPresent.has("won") || !kindsPresent.has("lost") ? "Add at least one won stage and one lost stage so deals can be closed." : null;

  return (
    <section aria-label={`Stages of ${pipeline.name}`} className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-md font-semibold">{pipeline.name} stages</h2>
          <p className="text-xs text-fg-subtle">{canManage ? "Drag rows or use the arrows to reorder. Changes save immediately." : "Read-only: you need the manage-pipelines permission to edit."}</p>
        </div>
        {canManage ? (
          <Button size="sm" variant="secondary" onClick={() => setEditingId("new")} disabled={editingId === "new"}>
            <Plus /> Add stage
          </Button>
        ) : null}
      </div>
      {warning ? <p className="mb-3 rounded-sm border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-warning">{warning}</p> : null}
      <Table>
        <caption className="sr-only">Stages in order</caption>
        <TableHeader>
          <TableRow>
            {canManage ? <TableHead className="w-8"><span className="sr-only">Reorder</span></TableHead> : null}
            <TableHead>Name</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead className="text-right">Probability</TableHead>
            <TableHead>Colour</TableHead>
            <TableHead className="hidden md:table-cell">Description</TableHead>
            {canManage ? <TableHead className="w-32"><span className="sr-only">Actions</span></TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {stages.map((stage, index) =>
            editingId === stage.id ? (
              <StageFormRow key={stage.id} pipelineId={pipeline.id} stage={stage} canManage={canManage} onDone={() => setEditingId(null)} onSaved={invalidate} />
            ) : (
              <TableRow
                key={stage.id}
                draggable={canManage && editingId === null}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", stage.id);
                  e.dataTransfer.effectAllowed = "move";
                  setDragId(stage.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
                onDragOver={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (overId !== stage.id) setOverId(stage.id);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOn(stage.id);
                  setDragId(null);
                  setOverId(null);
                }}
                className={cn(dragId === stage.id && "opacity-50", overId === stage.id && dragId !== stage.id && "bg-primary-soft/40")}
              >
                {canManage ? (
                  <TableCell className="text-fg-subtle">
                    <GripVertical className="size-4 cursor-grab" aria-hidden />
                  </TableCell>
                ) : null}
                <TableCell>
                  <span className="inline-flex items-center gap-2 font-medium">
                    <span className={cn("size-2.5 rounded-full", stageDotClass(stage.color_token))} aria-hidden />
                    {stage.name}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge variant={stage.kind === "won" ? "success" : stage.kind === "lost" ? "danger" : "neutral"}>{KINDS.find((k) => k.value === stage.kind)?.label ?? stage.kind}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">{stage.default_probability}%</TableCell>
                <TableCell>
                  <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs capitalize", colorClasses(stage.color_token))}>{stage.color_token}</span>
                </TableCell>
                <TableCell className="hidden max-w-64 truncate text-fg-muted md:table-cell" title={stage.description}>
                  {stage.description || "—"}
                </TableCell>
                {canManage ? (
                  <TableCell>
                    <div className="flex items-center justify-end gap-0.5">
                      <Button variant="ghost" size="icon-sm" aria-label={`Move ${stage.name} up`} disabled={index === 0 || reorder.isPending} onClick={() => moveBy(index, -1)}>
                        <ArrowUp />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Move ${stage.name} down`} disabled={index === stages.length - 1 || reorder.isPending} onClick={() => moveBy(index, 1)}>
                        <ArrowDown />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${stage.name}`} onClick={() => setEditingId(stage.id)}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Archive ${stage.name}`} onClick={() => setArchiving(stage)}>
                        <Archive />
                      </Button>
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ),
          )}
          {editingId === "new" ? <StageFormRow pipelineId={pipeline.id} stage={null} canManage={canManage} onDone={() => setEditingId(null)} onSaved={invalidate} /> : null}
          {stages.length === 0 && editingId !== "new" ? (
            <TableRow>
              <TableCell colSpan={canManage ? 7 : 5} className="py-8 text-center text-sm text-fg-muted">
                No active stages.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={`Archive ${archiving?.name ?? "stage"}?`}
        description="Stages with deals in them cannot be archived, and a pipeline must keep a won and a lost stage."
        confirmLabel="Archive stage"
        destructive
        loading={archive.isPending}
        onConfirm={() => archiving && archive.mutate(archiving)}
      />
    </section>
  );
}

function StageFormRow({
  pipelineId,
  stage,
  canManage,
  onDone,
  onSaved,
}: {
  pipelineId: string;
  stage: PipelineStage | null;
  canManage: boolean;
  onDone: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const { toast } = useToast();
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const form = useForm<StageFormValues>({
    resolver: zodResolver(stageSchema),
    defaultValues: {
      name: stage?.name ?? "",
      kind: stage?.kind ?? "open",
      default_probability: String(stage?.default_probability ?? 10),
      color_token: stage?.color_token ?? "slate",
      description: stage?.description ?? "",
    },
  });
  const formId = React.useId();

  const mutation = useMutation({
    mutationFn: (values: StageFormValues) => (stage ? updateStage(stage.id, toStageInput(values)) : addStage(pipelineId, toStageInput(values))),
    onSuccess: async (saved) => {
      await onSaved();
      toast({ tone: "success", title: stage ? "Stage updated" : "Stage added", description: saved.name });
      onDone();
    },
    onError: (err) => {
      if (isApiError(err) && err.isValidation) setFieldErrors(err.fieldErrors());
      else toast({ tone: "error", title: "Could not save stage", description: errorMessage(err) });
    },
  });

  const submit = form.handleSubmit((v) => {
    setFieldErrors({});
    mutation.mutate(v);
  });

  const kind = form.watch("kind");

  return (
    <TableRow className="bg-primary-soft/20 align-top hover:bg-primary-soft/20">
      {canManage ? <TableCell /> : null}
      <TableCell colSpan={5} className="py-3">
        <form id={formId} onSubmit={submit} noValidate className="grid gap-3 md:grid-cols-[minmax(0,1.5fr)_7rem_6rem_7rem_minmax(0,2fr)]">
          <FormField control={form.control} name="name" label="Name" serverError={fieldErrors.name}>
            {(field) => <Input {...field} autoFocus maxLength={80} value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
          </FormField>
          <FormField control={form.control} name="kind" label="Kind" serverError={fieldErrors.kind}>
            {(field) => (
              <Select
                value={field.value}
                onValueChange={(v) => {
                  field.onChange(v as StageKind);
                  if (v === "won") form.setValue("default_probability", "100");
                  if (v === "lost") form.setValue("default_probability", "0");
                }}
              >
                <SelectTrigger id={field.id} aria-invalid={field["aria-invalid"]} aria-describedby={field["aria-describedby"]}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k.value} value={k.value}>
                      {k.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <FormField control={form.control} name="default_probability" label="Probability %" serverError={fieldErrors.default_probability}>
            {(field) => <Input {...field} inputMode="numeric" value={field.value} onChange={(e) => field.onChange(e.target.value)} disabled={kind !== "open"} />}
          </FormField>
          <FormField control={form.control} name="color_token" label="Colour" serverError={fieldErrors.color_token}>
            {(field) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id={field.id} aria-invalid={field["aria-invalid"]} aria-describedby={field["aria-describedby"]}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TAG_COLORS.map((c) => (
                    <SelectItem key={c} value={c}>
                      <span className="inline-flex items-center gap-2 capitalize">
                        <span className={cn("size-2.5 rounded-full", stageDotClass(c))} aria-hidden />
                        {c}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <FormField control={form.control} name="description" label="Description" serverError={fieldErrors.description}>
            {(field) => <Input {...field} maxLength={255} placeholder="Optional" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
          </FormField>
          <FormError message={fieldErrors.non_field_errors} />
        </form>
      </TableCell>
      {canManage ? (
        <TableCell className="py-3">
          <div className="flex items-center justify-end gap-0.5 pt-5">
            <Button type="submit" form={formId} variant="ghost" size="icon-sm" aria-label="Save stage" loading={mutation.isPending}>
              {mutation.isPending ? null : <Check />}
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Cancel" onClick={onDone} disabled={mutation.isPending}>
              <X />
            </Button>
          </div>
        </TableCell>
      ) : null}
    </TableRow>
  );
}
