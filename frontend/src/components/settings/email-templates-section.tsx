"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { FileText, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input, Textarea } from "@/components/ui/input";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { createEmailTemplate, deleteEmailTemplate, listEmailTemplates, updateEmailTemplate } from "@/lib/api/crm";
import type { EmailTemplate } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { formatDateTime } from "@/lib/utils";

/** Placeholders the server fills when a template is rendered for a contact/deal. */
export const EMAIL_PLACEHOLDERS: { token: string; description: string }[] = [
  { token: "{{first_name}}", description: "Contact's first name" },
  { token: "{{last_name}}", description: "Contact's last name" },
  { token: "{{full_name}}", description: "Contact's full name" },
  { token: "{{company}}", description: "Company name" },
  { token: "{{deal_name}}", description: "Deal name" },
  { token: "{{owner_name}}", description: "Your name" },
];

const templateSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120, "Use at most 120 characters."),
  subject: z.string().trim().max(255, "Subject is too long."),
  body: z.string().min(1, "Write the message body.").max(20_000, "Body is too long."),
  is_shared: z.boolean(),
});
type TemplateInput = z.infer<typeof templateSchema>;

export function EmailTemplatesSection({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const templates = useQuery({ queryKey: crmKeys.emailTemplates, queryFn: listEmailTemplates });
  const [editing, setEditing] = React.useState<EmailTemplate | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<EmailTemplate | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => deleteEmailTemplate(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: crmKeys.emailTemplates });
      toast({ tone: "success", title: "Template deleted" });
      setDeleting(null);
    },
    onError: (err) => toast({ tone: "error", title: "Could not delete template", description: errorMessage(err) }),
  });

  const rows = templates.data?.results ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <FileText className="size-4 text-primary" aria-hidden /> Email templates
            </CardTitle>
            <CardDescription>Reusable subjects and bodies with placeholders that are filled in for the contact and deal when you pick one in the composer.</CardDescription>
          </div>
          {canManage ? (
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus /> New template
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {templates.isPending ? (
          <SkeletonRows rows={3} />
        ) : templates.isError ? (
          <p className="text-sm text-danger">{errorMessage(templates.error)}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-fg-muted">
            No templates yet.{canManage ? " Create one to save time on emails you send often." : " Templates shared by your team will appear here."}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="hidden sm:table-cell">Subject</TableHead>
                <TableHead>Visibility</TableHead>
                <TableHead className="hidden md:table-cell">Updated</TableHead>
                {canManage ? (
                  <TableHead className="w-12">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.name}</TableCell>
                  <TableCell className="hidden max-w-xs truncate text-fg-muted sm:table-cell" title={t.subject}>
                    {t.subject || "—"}
                  </TableCell>
                  <TableCell>{t.is_shared ? <Badge variant="primary">Shared</Badge> : <Badge>Private</Badge>}</TableCell>
                  <TableCell className="hidden whitespace-nowrap text-fg-muted md:table-cell">{formatDateTime(t.updated_at)}</TableCell>
                  {canManage ? (
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${t.name}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setEditing(t)}>
                            <Pencil /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem destructive onSelect={() => setDeleting(t)}>
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
      </CardContent>

      <EmailTemplateDialog template={editing} onOpenChange={(open) => !open && setEditing(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting?.name ?? "template"}”?`}
        description="Emails already sent with it are not affected. This cannot be undone."
        confirmLabel="Delete template"
        destructive
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Card>
  );
}

export function EmailTemplateDialog({ template, onOpenChange }: { template: EmailTemplate | "new" | null; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const isNew = template === "new";
  const existing = template && template !== "new" ? template : null;

  const form = useForm<TemplateInput>({ resolver: zodResolver(templateSchema), defaultValues: { name: "", subject: "", body: "", is_shared: false } });

  React.useEffect(() => {
    if (template) {
      form.reset({ name: existing?.name ?? "", subject: existing?.subject ?? "", body: existing?.body ?? "", is_shared: existing?.is_shared ?? false });
      setFieldErrors({});
    }
  }, [template, existing, form]);

  const mutation = useMutation({
    mutationFn: (values: TemplateInput) => (existing ? updateEmailTemplate(existing.id, values) : createEmailTemplate(values)),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: crmKeys.emailTemplates });
      toast({ tone: "success", title: isNew ? "Template created" : "Template updated", description: saved.name });
      onOpenChange(false);
    },
    onError: (err) => {
      if (isApiError(err) && err.isValidation) {
        setFieldErrors(err.fieldErrors());
        return;
      }
      toast({ tone: "error", title: "Could not save template", description: errorMessage(err) });
    },
  });

  const insertPlaceholder = (token: string) => {
    const current = form.getValues("body");
    form.setValue("body", current ? `${current}${current.endsWith(" ") || current.endsWith("\n") ? "" : " "}${token}` : token, { shouldDirty: true });
  };

  return (
    <Dialog open={template !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <form
          onSubmit={form.handleSubmit((values) => {
            setFieldErrors({});
            mutation.mutate(values);
          })}
          className="grid gap-4"
          noValidate
        >
          <DialogHeader>
            <DialogTitle>{isNew ? "New email template" : "Edit email template"}</DialogTitle>
            <DialogDescription>Plain text. Placeholders are replaced with the contact and deal details when the template is used.</DialogDescription>
          </DialogHeader>
          <FormError message={fieldErrors.non_field_errors} />
          <FormField control={form.control} name="name" label="Name" serverError={fieldErrors.name}>
            {(f) => <Input {...f} autoFocus maxLength={120} placeholder="Follow-up after demo" value={f.value} onChange={(e) => f.onChange(e.target.value)} />}
          </FormField>
          <FormField control={form.control} name="subject" label="Subject" serverError={fieldErrors.subject}>
            {(f) => <Input {...f} maxLength={255} placeholder="Next steps for {{company}}" value={f.value} onChange={(e) => f.onChange(e.target.value)} />}
          </FormField>
          <FormField control={form.control} name="body" label="Body" serverError={fieldErrors.body}>
            {(f) => <Textarea {...f} rows={8} maxLength={20_000} value={f.value} onChange={(e) => f.onChange(e.target.value)} />}
          </FormField>
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-fg-muted">Placeholders (click to insert)</span>
            <div className="flex flex-wrap gap-1.5">
              {EMAIL_PLACEHOLDERS.map((p) => (
                <button
                  key={p.token}
                  type="button"
                  title={p.description}
                  onClick={() => insertPlaceholder(p.token)}
                  className="rounded-sm border border-border bg-bg-subtle px-1.5 py-0.5 font-mono text-[11px] text-fg hover:border-border-strong"
                >
                  {p.token}
                </button>
              ))}
            </div>
          </div>
          <FormField control={form.control} name="is_shared" label="Share with the whole team" description="Private templates are visible only to you." serverError={fieldErrors.is_shared}>
            {(f) => <Switch id={f.id} checked={f.value} onCheckedChange={f.onChange} aria-describedby={f["aria-describedby"]} />}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {isNew ? "Create template" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
