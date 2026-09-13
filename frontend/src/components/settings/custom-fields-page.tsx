"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Plus, SlidersHorizontal } from "lucide-react";
import { z } from "zod";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { archiveCustomField, createCustomField, restoreCustomField, updateCustomField } from "@/lib/api/crm";
import { listCustomFields } from "@/lib/api/crm";
import {
  CUSTOM_FIELD_TYPES,
  ENTITY_LABELS,
  ENTITY_TYPES,
  type CustomFieldDefinition,
  type CustomFieldType,
  type EntityType,
} from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { hasPermission, useSession } from "@/lib/session";
import { formatDateTime } from "@/lib/utils";

/** Mirrors the backend rule: lowercase identifier, max 40 characters. */
export const CUSTOM_FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const CUSTOM_FIELD_KEY_MESSAGE = "Use lowercase letters, digits and underscores, starting with a letter (max 40 characters).";

const MAX_OPTIONS = 100;

export const FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "Text",
  textarea: "Long text",
  integer: "Whole number",
  number: "Number",
  currency: "Currency",
  percent: "Percent",
  date: "Date",
  datetime: "Date & time",
  checkbox: "Checkbox",
  dropdown: "Dropdown",
  multi_select: "Multi-select",
  email: "Email",
  phone: "Phone",
  url: "URL",
};

const CUSTOM_FIELDS_ROOT = ["crm", "custom-fields"] as const;

function needsOptions(type: CustomFieldType): boolean {
  return type === "dropdown" || type === "multi_select";
}

/** One option per line; trims, drops blanks, keeps order. */
export function parseOptions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Suggest a key from a label ("Lead Score!" → "lead_score"). */
export function keyFromLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "")
    .slice(0, 40);
}

const fieldSchema = z
  .object({
    label: z.string().trim().min(1, "Label is required.").max(80, "Label is too long."),
    key: z.string().trim().regex(CUSTOM_FIELD_KEY_RE, CUSTOM_FIELD_KEY_MESSAGE),
    description: z.string().trim().max(500, "Description is too long."),
    field_type: z.enum(CUSTOM_FIELD_TYPES, { message: "Choose a type." }),
    options: z.string(),
    is_required: z.boolean(),
  })
  .superRefine((value, ctx) => {
    const options = parseOptions(value.options);
    if (needsOptions(value.field_type)) {
      if (options.length === 0) ctx.addIssue({ code: "custom", path: ["options"], message: "Add at least one option (one per line)." });
      else if (options.length > MAX_OPTIONS) ctx.addIssue({ code: "custom", path: ["options"], message: `Use at most ${MAX_OPTIONS} options.` });
      else if (new Set(options).size !== options.length) ctx.addIssue({ code: "custom", path: ["options"], message: "Options must be unique." });
      else if (options.some((o) => o.length > 100)) ctx.addIssue({ code: "custom", path: ["options"], message: "Each option must be 100 characters or fewer." });
    } else if (options.length > 0) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Options only apply to dropdown and multi-select fields." });
    }
  });
type FieldFormInput = z.infer<typeof fieldSchema>;

const KNOWN_FIELDS = new Set(["label", "key", "description", "field_type", "options", "is_required", "non_field_errors"]);

/** Keep known field errors on their inputs; fold anything else into the banner. */
function mapServerErrors(errors: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const other: string[] = [];
  for (const [field, message] of Object.entries(errors)) {
    if (KNOWN_FIELDS.has(field)) out[field] = message;
    else other.push(`${field}: ${message}`);
  }
  if (other.length) out.non_field_errors = [out.non_field_errors, ...other].filter(Boolean).join(" ");
  return out;
}

function isEntityType(value: string): value is EntityType {
  return (ENTITY_TYPES as readonly string[]).includes(value);
}

export function CustomFieldsPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canView = hasPermission(active, "customfields.view");
  const canManage = hasPermission(active, "customfields.manage");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [entity, setEntity] = React.useState<EntityType>("contact");
  const [showArchived, setShowArchived] = React.useState(false);
  const [editing, setEditing] = React.useState<CustomFieldDefinition | "new" | null>(null);
  const [archiving, setArchiving] = React.useState<CustomFieldDefinition | null>(null);

  const fields = useQuery({
    queryKey: crmKeys.customFields(entity, showArchived),
    queryFn: () => listCustomFields(entity, showArchived),
    enabled: canView,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: CUSTOM_FIELDS_ROOT });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => archiveCustomField(id),
    onSuccess: async () => {
      await invalidate();
      toast({ tone: "success", title: "Field archived", description: "Existing values are kept; the field no longer appears on forms." });
      setArchiving(null);
    },
    onError: (err) => toast({ tone: "error", title: "Could not archive field", description: errorMessage(err) }),
  });

  const restoreMutation = useMutation({
    mutationFn: (id: string) => restoreCustomField(id),
    onSuccess: async () => {
      await invalidate();
      toast({ tone: "success", title: "Field restored" });
    },
    onError: (err) => toast({ tone: "error", title: "Could not restore field", description: errorMessage(err) }),
  });

  if (!canView) {
    return (
      <div>
        <PageHeader title="Custom fields" />
        <EmptyState icon={<SlidersHorizontal />} title="No access" description="Your role does not include permission to view custom fields." />
      </div>
    );
  }

  const rows = (fields.data?.results ?? []).slice().sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));
  const archivedId = "custom-fields-show-archived";

  return (
    <div>
      <PageHeader
        title="Custom fields"
        description="Add your own fields to contacts, companies, deals and products. Keys are permanent; labels and options can change."
        actions={
          canManage ? (
            <Button onClick={() => setEditing("new")}>
              <Plus /> New field
            </Button>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Tabs value={entity} onValueChange={(v) => isEntityType(v) && setEntity(v)}>
          <TabsList aria-label="Record type">
            {ENTITY_TYPES.map((type) => (
              <TabsTrigger key={type} value={type}>
                {ENTITY_LABELS[type].plural}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <Switch id={archivedId} checked={showArchived} onCheckedChange={setShowArchived} />
          <Label htmlFor={archivedId} className="cursor-pointer">
            Show archived
          </Label>
        </div>
      </div>

      {fields.isPending ? (
        <SkeletonRows rows={4} />
      ) : fields.isError ? (
        <EmptyState
          title="Could not load custom fields"
          description={errorMessage(fields.error)}
          action={
            <Button variant="secondary" onClick={() => fields.refetch()}>
              Retry
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<SlidersHorizontal />}
          title={showArchived ? "No archived fields" : `No custom fields for ${ENTITY_LABELS[entity].plural.toLowerCase()} yet`}
          description={showArchived ? "Archived fields will show up here." : "Custom fields appear on the record form, in tables and in filters."}
          action={canManage && !showArchived ? <Button onClick={() => setEditing("new")}>Create a field</Button> : null}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Label</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="hidden sm:table-cell">Required</TableHead>
              <TableHead className="hidden md:table-cell">Options</TableHead>
              <TableHead className="hidden lg:table-cell">Position</TableHead>
              {canManage ? (
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((field) => {
              const archived = Boolean(field.archived_at);
              return (
                <TableRow key={field.id} className={archived ? "opacity-70" : undefined}>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{field.label}</span>
                      {archived ? <Badge variant="outline">Archived</Badge> : null}
                    </div>
                    {field.description ? <p className="mt-0.5 max-w-xs truncate text-xs text-fg-subtle">{field.description}</p> : null}
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-xs">{field.key}</code>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{FIELD_TYPE_LABELS[field.field_type] ?? field.field_type}</TableCell>
                  <TableCell className="hidden sm:table-cell">{field.is_required ? <Badge variant="primary">Required</Badge> : <span className="text-fg-subtle">—</span>}</TableCell>
                  <TableCell className="hidden md:table-cell">
                    {field.options.length > 0 ? (
                      <span className="block max-w-xs truncate text-xs text-fg-muted" title={field.options.join(", ")}>
                        {field.options.length} {field.options.length === 1 ? "option" : "options"}: {field.options.join(", ")}
                      </span>
                    ) : (
                      <span className="text-fg-subtle">—</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-fg-muted lg:table-cell">{field.position}</TableCell>
                  {canManage ? (
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${field.label}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {archived ? (
                            <DropdownMenuItem onSelect={() => restoreMutation.mutate(field.id)}>
                              <ArchiveRestore /> Restore
                            </DropdownMenuItem>
                          ) : (
                            <>
                              <DropdownMenuItem onSelect={() => setEditing(field)}>
                                <Pencil /> Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem destructive onSelect={() => setArchiving(field)}>
                                <Archive /> Archive
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <CustomFieldDialog entity={entity} field={editing} onOpenChange={(open) => !open && setEditing(null)} />
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => !open && setArchiving(null)}
        title={`Archive ${archiving?.label ?? "field"}?`}
        description="The field disappears from forms, tables and filters. Values already stored on records are kept, and you can restore the field later."
        confirmLabel="Archive field"
        destructive
        loading={archiveMutation.isPending}
        onConfirm={() => archiving && archiveMutation.mutate(archiving.id)}
      />
    </div>
  );
}

/** Create/edit dialog. Key and type are fixed once a field exists. */
export function CustomFieldDialog({
  entity,
  field,
  onOpenChange,
}: {
  entity: EntityType;
  field: CustomFieldDefinition | "new" | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const isNew = field === "new";
  const existing = field && field !== "new" ? field : null;

  const form = useForm<FieldFormInput>({
    resolver: zodResolver(fieldSchema),
    defaultValues: { label: "", key: "", description: "", field_type: "text", options: "", is_required: false },
  });

  React.useEffect(() => {
    if (field) {
      form.reset({
        label: existing?.label ?? "",
        key: existing?.key ?? "",
        description: existing?.description ?? "",
        field_type: existing?.field_type ?? "text",
        options: existing?.options.join("\n") ?? "",
        is_required: existing?.is_required ?? false,
      });
      setFieldErrors({});
    }
  }, [field, existing, form]);

  const fieldType = form.watch("field_type");
  const showOptions = needsOptions(fieldType);

  const mutation = useMutation({
    mutationFn: (values: FieldFormInput) => {
      const options = needsOptions(values.field_type) ? parseOptions(values.options) : undefined;
      if (existing) {
        return updateCustomField(existing.id, {
          label: values.label,
          description: values.description,
          is_required: values.is_required,
          ...(options ? { options } : {}),
        });
      }
      return createCustomField({
        entity_type: entity,
        key: values.key,
        label: values.label,
        description: values.description,
        field_type: values.field_type,
        is_required: values.is_required,
        ...(options ? { options } : {}),
      });
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: CUSTOM_FIELDS_ROOT });
      toast({ tone: "success", title: isNew ? "Field created" : "Field updated", description: saved.label });
      onOpenChange(false);
    },
    onError: (err) => {
      if (isApiError(err)) {
        if (err.isValidation) {
          setFieldErrors(mapServerErrors(err.fieldErrors()));
          return;
        }
        if (err.status === 409) {
          setFieldErrors({ key: "A field with this key already exists for this record type." });
          return;
        }
      }
      toast({ tone: "error", title: "Could not save field", description: errorMessage(err) });
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    setFieldErrors({});
    mutation.mutate(values);
  });

  return (
    <Dialog open={field !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{isNew ? `New ${ENTITY_LABELS[entity].singular.toLowerCase()} field` : `Edit ${existing?.label ?? "field"}`}</DialogTitle>
            <DialogDescription>
              {isNew ? "The key and type cannot be changed after the field is created." : "The key and type are fixed; everything else can change."}
            </DialogDescription>
          </DialogHeader>
          <FormError message={fieldErrors.non_field_errors} />

          <FormField control={form.control} name="label" label="Label" serverError={fieldErrors.label}>
            {(f) => (
              <Input
                {...f}
                autoFocus
                maxLength={80}
                placeholder="Lead score"
                value={f.value}
                onChange={(e) => {
                  f.onChange(e.target.value);
                  if (isNew && !form.formState.dirtyFields.key) form.setValue("key", keyFromLabel(e.target.value), { shouldDirty: false });
                }}
              />
            )}
          </FormField>

          <FormField
            control={form.control}
            name="key"
            label="Key"
            description={isNew ? "Used in the API, imports and filters. Lowercase letters, digits and underscores." : undefined}
            serverError={fieldErrors.key}
          >
            {(f) => (
              <Input
                {...f}
                className="font-mono"
                maxLength={40}
                placeholder="lead_score"
                autoComplete="off"
                spellCheck={false}
                readOnly={!isNew}
                aria-readonly={!isNew || undefined}
                value={f.value}
                onChange={(e) => f.onChange(e.target.value)}
              />
            )}
          </FormField>

          <FormField control={form.control} name="field_type" label="Type" serverError={fieldErrors.field_type}>
            {(f) => (
              <Select value={f.value} onValueChange={f.onChange} disabled={!isNew}>
                <SelectTrigger id={f.id} aria-invalid={f["aria-invalid"]} aria-describedby={f["aria-describedby"]} aria-label="Type">
                  <SelectValue placeholder="Choose a type" />
                </SelectTrigger>
                <SelectContent>
                  {CUSTOM_FIELD_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {FIELD_TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>

          {showOptions ? (
            <FormField control={form.control} name="options" label="Options" description="One option per line, up to 100." serverError={fieldErrors.options}>
              {(f) => (
                <Textarea
                  id={f.id}
                  name={f.name}
                  ref={f.ref}
                  rows={5}
                  placeholder={"Low\nMedium\nHigh"}
                  aria-invalid={f["aria-invalid"]}
                  aria-describedby={f["aria-describedby"]}
                  value={f.value}
                  onBlur={f.onBlur}
                  onChange={(e) => f.onChange(e.target.value)}
                />
              )}
            </FormField>
          ) : null}

          <FormField control={form.control} name="description" label="Help text" description="Shown under the field on forms." serverError={fieldErrors.description}>
            {(f) => <Input {...f} maxLength={500} value={f.value} onChange={(e) => f.onChange(e.target.value)} />}
          </FormField>

          <FormField control={form.control} name="is_required" label="Required" serverError={fieldErrors.is_required}>
            {(f) => (
              <div className="flex h-9 items-center gap-2">
                <Switch id={f.id} checked={f.value} onCheckedChange={f.onChange} aria-describedby={f["aria-describedby"]} />
                <span className="text-xs text-fg-subtle">People must fill this in when saving a record.</span>
              </div>
            )}
          </FormField>

          {existing ? (
            <p className="text-xs text-fg-subtle">
              Created {formatDateTime(existing.created_at)} · Position {existing.position}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {isNew ? "Create field" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
