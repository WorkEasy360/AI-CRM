"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { FileText, Plus, Trash2 } from "lucide-react";
import { z } from "zod";
import { countTemplateParams } from "@/components/messaging/whatsapp-template-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input, Textarea } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { createWhatsAppTemplate, deleteWhatsAppTemplate, listWhatsAppTemplates } from "@/lib/api/crm";
import type { WhatsAppTemplate } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { formatDateTime } from "@/lib/utils";

/** Meta's template categories. */
const CATEGORIES = ["MARKETING", "UTILITY", "AUTHENTICATION"] as const;
const NONE = "__none__";

const templateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(120, "Use at most 120 characters.")
    .regex(/^[a-z0-9_]+$/, "Use lowercase letters, digits and underscores, exactly as approved in Meta."),
  language: z.string().trim().min(2, "Enter the language code, e.g. en or en_US.").max(16, "Language code is too long."),
  category: z.string(),
  body: z.string().trim().max(2000, "Body is too long."),
});
type TemplateInput = z.infer<typeof templateSchema>;

export function WhatsAppTemplatesSection({ canManage }: { canManage: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const templates = useQuery({ queryKey: crmKeys.whatsappTemplates, queryFn: listWhatsAppTemplates });
  const [adding, setAdding] = React.useState(false);
  const [deleting, setDeleting] = React.useState<WhatsAppTemplate | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => deleteWhatsAppTemplate(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: crmKeys.whatsappTemplates });
      toast({ tone: "success", title: "Template removed" });
      setDeleting(null);
    },
    onError: (err) => toast({ tone: "error", title: "Could not remove template", description: errorMessage(err) }),
  });

  const rows = templates.data?.results ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <FileText className="size-4 text-primary" aria-hidden /> Message templates
            </CardTitle>
            <CardDescription>
              Templates approved in Meta Business Manager, recorded here so they can be sent outside the 24-hour reply window. Approval itself happens in Meta.
            </CardDescription>
          </div>
          {canManage ? (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus /> Add template
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {templates.isPending ? (
          <SkeletonRows rows={2} />
        ) : templates.isError ? (
          <p className="text-sm text-danger">{errorMessage(templates.error)}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-fg-muted">No templates recorded yet.{canManage ? " Add the templates Meta has approved for your number." : ""}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Language</TableHead>
                <TableHead className="hidden sm:table-cell">Category</TableHead>
                <TableHead className="hidden sm:table-cell">Placeholders</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Added</TableHead>
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
                  <TableCell>
                    <span className="font-mono text-xs font-medium">{t.name}</span>
                    {t.body ? (
                      <span className="mt-0.5 block max-w-xs truncate text-xs text-fg-subtle" title={t.body}>
                        {t.body}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-fg-muted">{t.language}</TableCell>
                  <TableCell className="hidden text-fg-muted sm:table-cell">{t.category || "—"}</TableCell>
                  <TableCell className="hidden text-fg-muted sm:table-cell">{t.parameter_count}</TableCell>
                  <TableCell>
                    <Badge variant={t.status.toLowerCase() === "approved" ? "success" : "warning"}>{t.status}</Badge>
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap text-fg-muted md:table-cell">{formatDateTime(t.created_at)}</TableCell>
                  {canManage ? (
                    <TableCell>
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove ${t.name}`} onClick={() => setDeleting(t)}>
                        <Trash2 />
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <WhatsAppTemplateDialog open={adding} onOpenChange={setAdding} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Remove “${deleting?.name ?? "template"}”?`}
        description="It will no longer be offered when composing messages. The template stays approved in Meta and can be added again."
        confirmLabel="Remove"
        destructive
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </Card>
  );
}

export function WhatsAppTemplateDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const form = useForm<TemplateInput>({ resolver: zodResolver(templateSchema), defaultValues: { name: "", language: "en", category: NONE, body: "" } });

  React.useEffect(() => {
    if (open) {
      form.reset({ name: "", language: "en", category: NONE, body: "" });
      setFieldErrors({});
    }
  }, [open, form]);

  const body = form.watch("body");
  const paramCount = countTemplateParams(body);

  const mutation = useMutation({
    mutationFn: (v: TemplateInput) => createWhatsAppTemplate({ name: v.name, language: v.language, category: v.category === NONE ? "" : v.category, body: v.body }),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: crmKeys.whatsappTemplates });
      toast({ tone: "success", title: "Template added", description: saved.name });
      onOpenChange(false);
    },
    onError: (err) => {
      if (isApiError(err)) {
        if (err.isValidation) {
          setFieldErrors(err.fieldErrors());
          return;
        }
        if (err.status === 409) {
          setFieldErrors({ name: "A template with this name and language already exists." });
          return;
        }
      }
      toast({ tone: "error", title: "Could not add template", description: errorMessage(err) });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-xl">
        <form
          onSubmit={form.handleSubmit((v) => {
            setFieldErrors({});
            mutation.mutate(v);
          })}
          className="grid gap-4"
          noValidate
        >
          <DialogHeader>
            <DialogTitle>Add message template</DialogTitle>
            <DialogDescription>Enter the template exactly as approved in Meta. Numbered placeholders such as {"{{1}}"} become inputs when the template is sent.</DialogDescription>
          </DialogHeader>
          <FormError message={fieldErrors.non_field_errors} />
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem]">
            <FormField control={form.control} name="name" label="Name" description="lowercase_with_underscores" serverError={fieldErrors.name}>
              {(f) => <Input {...f} autoFocus maxLength={120} placeholder="order_update" className="font-mono" value={f.value} onChange={(e) => f.onChange(e.target.value)} />}
            </FormField>
            <FormField control={form.control} name="language" label="Language" serverError={fieldErrors.language}>
              {(f) => <Input {...f} maxLength={16} placeholder="en_US" value={f.value} onChange={(e) => f.onChange(e.target.value)} />}
            </FormField>
          </div>
          <FormField control={form.control} name="category" label="Category" serverError={fieldErrors.category}>
            {(f) => (
              <Select value={f.value} onValueChange={f.onChange}>
                <SelectTrigger id={f.id} aria-invalid={f["aria-invalid"]} aria-describedby={f["aria-describedby"]}>
                  <SelectValue placeholder="Not set" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not set</SelectItem>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c.charAt(0) + c.slice(1).toLowerCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <FormField
            control={form.control}
            name="body"
            label="Body"
            description={`Use {{1}}, {{2}}… for values filled in at send time. ${paramCount} placeholder${paramCount === 1 ? "" : "s"} detected.`}
            serverError={fieldErrors.body}
          >
            {(f) => <Textarea {...f} rows={5} maxLength={2000} placeholder="Hi {{1}}, your order {{2}} has shipped." value={f.value} onChange={(e) => f.onChange(e.target.value)} />}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              Add template
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
