"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Check, MoreHorizontal, Pencil, Plus, Tag as TagIcon, Trash2 } from "lucide-react";
import { z } from "zod";
import { PageHeader } from "@/components/page-header";
import { TagChip } from "@/components/crm/tag-picker";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { createTag, deleteTag, listTags, updateTag } from "@/lib/api/crm";
import { TAG_COLORS, type Tag, type TagColor } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { colorClasses } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { hasPermission, useSession } from "@/lib/session";
import { cn, formatDateTime } from "@/lib/utils";

const COLOR_LABELS: Record<TagColor, string> = {
  slate: "Slate",
  blue: "Blue",
  teal: "Teal",
  green: "Green",
  amber: "Amber",
  red: "Red",
  purple: "Purple",
  pink: "Pink",
};

const tagSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(40, "Use at most 40 characters."),
  color_token: z.enum(TAG_COLORS, { message: "Choose a colour." }),
});
type TagFormInput = z.infer<typeof tagSchema>;

function isTagColor(value: string): value is TagColor {
  return (TAG_COLORS as readonly string[]).includes(value);
}

export function TagsPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canView = hasPermission(active, "tags.view");
  const canManage = hasPermission(active, "tags.manage");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [editing, setEditing] = React.useState<Tag | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<Tag | null>(null);

  const tags = useQuery({ queryKey: crmKeys.tags, queryFn: listTags, enabled: canView });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteTag(id),
    onSuccess: async () => {
      await invalidateTagConsumers(queryClient);
      toast({ tone: "success", title: "Tag deleted" });
      setDeleting(null);
    },
    onError: (err) => toast({ tone: "error", title: "Could not delete tag", description: errorMessage(err) }),
  });

  if (!canView) {
    return (
      <div>
        <PageHeader title="Tags" />
        <EmptyState icon={<TagIcon />} title="No access" description="Your role does not include permission to view tags." />
      </div>
    );
  }

  const rows = (tags.data?.results ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <PageHeader
        title="Tags"
        description="Label contacts, companies, deals and products so you can filter and group them."
        actions={
          canManage ? (
            <Button onClick={() => setEditing("new")}>
              <Plus /> New tag
            </Button>
          ) : null
        }
      />

      {tags.isPending ? (
        <SkeletonRows rows={4} />
      ) : tags.isError ? (
        <EmptyState
          title="Could not load tags"
          description={errorMessage(tags.error)}
          action={
            <Button variant="secondary" onClick={() => tags.refetch()}>
              Retry
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<TagIcon />}
          title="No tags yet"
          description="Tags are shared across the organization and can be applied to any record."
          action={canManage ? <Button onClick={() => setEditing("new")}>Create a tag</Button> : null}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tag</TableHead>
              <TableHead>Usage</TableHead>
              <TableHead className="hidden sm:table-cell">Colour</TableHead>
              <TableHead className="hidden md:table-cell">Created</TableHead>
              {canManage ? (
                <TableHead className="w-12">
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((tag) => (
              <TableRow key={tag.id}>
                <TableCell>
                  <TagChip tag={tag} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-fg-muted">
                  {tag.usage_count.toLocaleString()} {tag.usage_count === 1 ? "record" : "records"}
                </TableCell>
                <TableCell className="hidden text-fg-muted sm:table-cell">{isTagColor(tag.color_token) ? COLOR_LABELS[tag.color_token] : tag.color_token}</TableCell>
                <TableCell className="hidden whitespace-nowrap text-fg-muted md:table-cell">{formatDateTime(tag.created_at)}</TableCell>
                {canManage ? (
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${tag.name}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setEditing(tag)}>
                          <Pencil /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem destructive onSelect={() => setDeleting(tag)}>
                          <Trash2 /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <TagDialog tag={editing} onOpenChange={(open) => !open && setEditing(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.name ?? "tag"}”?`}
        description={
          deleting
            ? `This removes it from ${deleting.usage_count.toLocaleString()} ${deleting.usage_count === 1 ? "record" : "records"}. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete tag"
        destructive
        loading={deleteMutation.isPending}
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
      />
    </div>
  );
}

/** Tags are embedded in every record, so lists and boards must refetch after a tag changes. */
async function invalidateTagConsumers(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: crmKeys.tags }),
    ...["contacts", "companies", "deals", "products"].map((path) => queryClient.invalidateQueries({ queryKey: ["crm", path] })),
  ]);
}

export function TagDialog({ tag, onOpenChange }: { tag: Tag | "new" | null; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const isNew = tag === "new";
  const existing = tag && tag !== "new" ? tag : null;

  const form = useForm<TagFormInput>({
    resolver: zodResolver(tagSchema),
    defaultValues: { name: "", color_token: "slate" },
  });

  React.useEffect(() => {
    if (tag) {
      form.reset({ name: existing?.name ?? "", color_token: existing && isTagColor(existing.color_token) ? existing.color_token : "slate" });
      setFieldErrors({});
    }
  }, [tag, existing, form]);

  const name = form.watch("name");
  const color = form.watch("color_token");

  const mutation = useMutation({
    mutationFn: (values: TagFormInput) => (existing ? updateTag(existing.id, values) : createTag(values)),
    onSuccess: async (saved) => {
      await invalidateTagConsumers(queryClient);
      toast({ tone: "success", title: isNew ? "Tag created" : "Tag updated", description: saved.name });
      onOpenChange(false);
    },
    onError: (err) => {
      if (isApiError(err)) {
        if (err.isValidation) {
          setFieldErrors(err.fieldErrors());
          return;
        }
        if (err.status === 409) {
          setFieldErrors({ name: "A tag with this name already exists." });
          return;
        }
      }
      toast({ tone: "error", title: "Could not save tag", description: errorMessage(err) });
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    setFieldErrors({});
    mutation.mutate(values);
  });

  return (
    <Dialog open={tag !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{isNew ? "New tag" : "Edit tag"}</DialogTitle>
            <DialogDescription>Names are unique within the organization (case-insensitive).</DialogDescription>
          </DialogHeader>
          <FormError message={fieldErrors.non_field_errors} />

          <FormField control={form.control} name="name" label="Name" serverError={fieldErrors.name}>
            {(f) => <Input {...f} autoFocus maxLength={40} placeholder="VIP" value={f.value} onChange={(e) => f.onChange(e.target.value)} />}
          </FormField>

          <FormField control={form.control} name="color_token" label="Colour" serverError={fieldErrors.color_token}>
            {(f) => (
              <div role="radiogroup" aria-labelledby={`${f.id}-label`} aria-describedby={f["aria-describedby"]} className="flex flex-wrap gap-2" id={f.id}>
                <span id={`${f.id}-label`} className="sr-only">
                  Colour
                </span>
                {TAG_COLORS.map((token) => {
                  const selected = f.value === token;
                  return (
                    <button
                      key={token}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={COLOR_LABELS[token]}
                      onClick={() => f.onChange(token)}
                      className={cn(
                        "flex size-8 items-center justify-center rounded-full border-2 transition-colors",
                        colorClasses(token),
                        selected ? "border-fg" : "border-transparent hover:border-border-strong",
                      )}
                    >
                      {selected ? <Check className="size-4" aria-hidden /> : null}
                    </button>
                  );
                })}
              </div>
            )}
          </FormField>

          <div className="flex items-center gap-2 text-sm text-fg-muted">
            Preview: <TagChip tag={{ id: "preview", name: name.trim() || "Tag", color_token: color }} />
          </div>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {isNew ? "Create tag" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
