"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BookOpen, History, MessageCircleQuestion, Pencil, Plus, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { HelpMarkdown } from "@/components/help/markdown";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import {
  createHelpArticle,
  deleteHelpArticle,
  getHelpAdminArticle,
  getHelpReport,
  listHelpAdminArticles,
  listHelpRevisions,
  listHelpUnanswered,
  restoreHelpRevision,
  saveHelpArticle,
  setHelpUnansweredStatus,
  type HelpArticleInput,
} from "@/lib/api/crm";
import type { HelpArticleEditable, HelpUnanswered } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { hasPermission, useSession } from "@/lib/session";
import { cn, formatDateTime } from "@/lib/utils";

const PERMISSION = "ai.settings.manage";
const BODY_TEMPLATE = `## Overview
What this is and why someone would use it.

## Before you start
- Who can do it (role or permission).

## Steps
1. Click **Settings** in the left sidebar.
2. Click **...**.

## Result
What the user sees when they are done.

## Tips
- A short tip.
`;

/**
 * Settings → AI Assistant → Knowledge Base. The product guide ships with the software; here a
 * workspace adds its own articles, or overrides a guide article for this workspace only, and sees
 * what members asked that the guide could not answer and how its answers were rated.
 */
export function KnowledgeBasePage() {
  const { data: session } = useSession();
  const canManage = hasPermission(session?.active, PERMISSION);
  const [editing, setEditing] = React.useState<EditorTarget | null>(null);

  if (!canManage) {
    return (
      <div>
        <PageHeader title="Knowledge Base" />
        <EmptyState icon={<BookOpen />} title="No access" description="Managing the knowledge base needs the AI settings permission (Owner or Admin)." />
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <Link href="/settings/ai" className="flex w-fit items-center gap-1 text-sm text-fg-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden /> AI Settings
      </Link>
      <PageHeader
        title="Knowledge Base"
        actions={
          <Button size="sm" className="gap-1.5" onClick={() => setEditing({ mode: "new" })}>
            <Plus className="size-4" aria-hidden /> New article
          </Button>
        }
      />
      <Tabs defaultValue="articles">
        <TabsList>
          <TabsTrigger value="articles">Articles</TabsTrigger>
          <TabsTrigger value="unanswered">Unanswered Questions</TabsTrigger>
          <TabsTrigger value="report">Feedback report</TabsTrigger>
        </TabsList>
        <TabsContent value="articles" className="mt-4">
          <ArticlesTab onEdit={setEditing} />
        </TabsContent>
        <TabsContent value="unanswered" className="mt-4">
          <UnansweredTab onCreate={(question) => setEditing({ mode: "new", fromQuestion: question })} />
        </TabsContent>
        <TabsContent value="report" className="mt-4">
          <ReportTab />
        </TabsContent>
      </Tabs>
      {editing ? <ArticleEditor target={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

type EditorTarget = { mode: "new"; fromQuestion?: HelpUnanswered } | { mode: "edit"; id: string };

function ArticlesTab({ onEdit }: { onEdit: (target: EditorTarget) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = React.useState("");
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const { data, isPending, isError, error } = useQuery({ queryKey: crmKeys.helpAdmin, queryFn: listHelpAdminArticles });
  const remove = useMutation({
    mutationFn: deleteHelpArticle,
    onSuccess: () => {
      toast({ tone: "success", title: "Article deleted" });
      setDeleting(null);
      queryClient.invalidateQueries({ queryKey: ["help"] });
    },
    onError: (err) => toast({ tone: "error", title: "Could not delete the article", description: errorMessage(err) }),
  });

  if (isPending) return <SkeletonRows rows={6} />;
  if (isError || !data) return <p className="text-sm text-danger">{errorMessage(error)}</p>;
  const needle = filter.trim().toLowerCase();
  const guide = data.global.filter((a) => !needle || a.title.toLowerCase().includes(needle) || a.module.toLowerCase().includes(needle));

  return (
    <div className="grid gap-6">
      <section aria-labelledby="kb-workspace" className="grid gap-2">
        <h2 id="kb-workspace" className="text-sm font-semibold text-fg">
          Your workspace&apos;s articles
        </h2>
        {data.workspace.length === 0 ? (
          <p className="text-sm text-fg-muted">None yet. Create one, or customise a guide article below.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Module</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Version</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.workspace.map((article) => (
                <TableRow key={article.id}>
                  <TableCell>
                    <span className="font-medium text-fg">{article.title}</span>
                    {article.overrides_global ? <span className="ml-2 rounded-full bg-bg-subtle px-1.5 text-[12px] text-fg-muted">Replaces guide article</span> : null}
                  </TableCell>
                  <TableCell>{article.module}</TableCell>
                  <TableCell>
                    <StatusBadge status={article.status} />
                  </TableCell>
                  <TableCell>v{article.version}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon-sm" aria-label={`Edit ${article.title}`} onClick={() => onEdit({ mode: "edit", id: article.id })}>
                      <Pencil />
                    </Button>
                    <Button variant="danger-ghost" size="icon-sm" aria-label={`Delete ${article.title}`} onClick={() => setDeleting(article.id)}>
                      <Trash2 />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section aria-labelledby="kb-guide" className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="kb-guide" className="text-sm font-semibold text-fg">
            WorkEasy CRM guide <span className="font-normal text-fg-subtle">({data.global.length})</span>
          </h2>
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter articles" aria-label="Filter guide articles" className="h-8 w-56" />
        </div>
        <p className="text-xs text-fg-muted">Updated with each release. Customising an article changes it for your workspace only.</p>
        <div className="max-h-[28rem] overflow-y-auto rounded-md border border-border">
          <Table>
            <TableBody>
              {guide.map((article) => (
                <TableRow key={article.id}>
                  <TableCell>
                    <Link href={`/help/${encodeURIComponent(article.id)}`} className="text-fg hover:underline">
                      {article.title}
                    </Link>
                  </TableCell>
                  <TableCell className="text-fg-muted">{article.module}</TableCell>
                  <TableCell className="text-right">
                    {article.customized ? (
                      <span className="text-xs text-fg-subtle">Customised</span>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => onEdit({ mode: "edit", id: article.id })}>
                        Customise
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this article?"
        description="Members stop seeing it straight away. If it replaced a guide article, the original guide article comes back."
        confirmLabel="Delete"
        destructive
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", status === "published" ? "bg-brand-soft text-brand" : "bg-bg-subtle text-fg-muted")}>
      {status === "published" ? "Published" : "Draft"}
    </span>
  );
}

type Draft = {
  slug: string;
  title: string;
  question: string;
  module: string;
  keywords: string;
  route: string;
  menu_path: string;
  spotlight: string;
  permission: string;
  related: string;
  body: string;
  status: "published" | "draft";
};

const EMPTY: Draft = {
  slug: "",
  title: "",
  question: "",
  module: "Getting Started",
  keywords: "",
  route: "/dashboard",
  menu_path: "",
  spotlight: "",
  permission: "",
  related: "",
  body: BODY_TEMPLATE,
  status: "draft",
};

function toDraft(article: HelpArticleEditable): Draft {
  return {
    slug: article.id,
    title: article.title,
    question: article.question,
    module: article.module,
    keywords: article.keywords.join(", "),
    route: article.route,
    menu_path: article.menu_path,
    spotlight: article.spotlight,
    permission: article.permission,
    related: article.related.join(", "),
    body: article.body,
    status: article.status,
  };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function ArticleEditor({ target, onClose }: { target: EditorTarget; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const editId = target.mode === "edit" ? target.id : "";
  const existing = useQuery({
    queryKey: crmKeys.helpAdminArticle(editId),
    queryFn: () => getHelpAdminArticle(editId),
    enabled: Boolean(editId),
  });
  const [draft, setDraft] = React.useState<Draft | null>(target.mode === "new" ? newDraft(target.fromQuestion) : null);
  const [tab, setTab] = React.useState<"write" | "preview" | "history">("write");
  React.useEffect(() => {
    if (existing.data && draft === null) setDraft(toDraft(existing.data));
  }, [existing.data, draft]);

  const article = existing.data;
  const isOrgArticle = article?.source === "org";
  const save = useMutation({
    mutationFn: (input: HelpArticleInput) =>
      target.mode === "new" ? createHelpArticle(input) : saveHelpArticle(target.id, { ...input, version: isOrgArticle ? article?.version : undefined }),
    onSuccess: (saved) => {
      toast({ tone: "success", title: saved.status === "published" ? "Article published" : "Draft saved" });
      queryClient.invalidateQueries({ queryKey: ["help"] });
      onClose();
    },
    onError: (err) => toast({ tone: "error", title: "Could not save the article", description: errorMessage(err) }),
  });

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    const list = (text: string) =>
      text
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    save.mutate({
      slug: target.mode === "new" ? draft.slug || slugify(draft.title) : undefined,
      title: draft.title.trim(),
      question: draft.question.trim(),
      module: draft.module,
      keywords: list(draft.keywords),
      route: draft.route.trim(),
      menu_path: draft.menu_path.trim(),
      spotlight: draft.spotlight.trim(),
      permission: draft.permission.trim(),
      related: list(draft.related),
      body: draft.body,
      status: draft.status,
      from_unanswered: target.mode === "new" ? (target.fromQuestion?.id ?? null) : null,
    });
  };

  const title = target.mode === "new" ? "New article" : isOrgArticle ? "Edit article" : "Customise guide article";
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {target.mode === "edit" && !isOrgArticle
              ? "Saving creates your workspace's version of this article. The original stays in the guide for everyone else."
              : "Use the exact button and menu names from the software, in bold. WorkEasy AI only answers with labels the article contains."}
          </DialogDescription>
        </DialogHeader>
        {!draft ? (
          <SkeletonRows rows={6} />
        ) : (
          <form id="kb-article" onSubmit={submit} className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Title" htmlFor="kb-title">
                <Input id="kb-title" value={draft.title} onChange={(e) => set("title", e.target.value)} maxLength={160} required />
              </Field>
              <Field label="Question it answers" htmlFor="kb-question">
                <Input id="kb-question" value={draft.question} onChange={(e) => set("question", e.target.value)} maxLength={200} placeholder="How do I…?" required />
              </Field>
              {target.mode === "new" ? (
                <Field label="Article id" htmlFor="kb-slug" hint="Lowercase words joined by hyphens. Left empty, it is made from the title.">
                  <Input id="kb-slug" value={draft.slug} onChange={(e) => set("slug", e.target.value)} maxLength={80} placeholder={slugify(draft.title) || "lead-qualification"} />
                </Field>
              ) : null}
              <Field label="Module" htmlFor="kb-module">
                <Select value={draft.module} onValueChange={(value) => set("module", value)}>
                  <SelectTrigger id="kb-module">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MODULES.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Page (route)" htmlFor="kb-route" hint="Where “Take me there” goes, e.g. /contacts">
                <Input id="kb-route" value={draft.route} onChange={(e) => set("route", e.target.value)} maxLength={200} required />
              </Field>
              <Field label="Menu path" htmlFor="kb-menu" hint="e.g. Settings → CRM Configuration → Tags">
                <Input id="kb-menu" value={draft.menu_path} onChange={(e) => set("menu_path", e.target.value)} maxLength={300} />
              </Field>
              <Field label="Button to highlight" htmlFor="kb-spot" hint="Exact label on that page (optional)">
                <Input id="kb-spot" value={draft.spotlight} onChange={(e) => set("spotlight", e.target.value)} maxLength={120} />
              </Field>
              <Field label="Permission needed" htmlFor="kb-perm" hint="Permission code, e.g. tags.manage (optional)">
                <Input id="kb-perm" value={draft.permission} onChange={(e) => set("permission", e.target.value)} maxLength={64} />
              </Field>
              <Field label="Keywords" htmlFor="kb-keywords" hint="Comma-separated: other words people use, incl. Hindi/Hinglish">
                <Input id="kb-keywords" value={draft.keywords} onChange={(e) => set("keywords", e.target.value)} />
              </Field>
              <Field label="Related article ids" htmlFor="kb-related" hint="Comma-separated (optional)">
                <Input id="kb-related" value={draft.related} onChange={(e) => set("related", e.target.value)} />
              </Field>
              <Field label="Status" htmlFor="kb-status">
                <Select value={draft.status} onValueChange={(value) => set("status", value as Draft["status"])}>
                  <SelectTrigger id="kb-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">Draft (only admins see it here)</SelectItem>
                    <SelectItem value="published">Published (WorkEasy AI answers from it)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <div role="tablist" aria-label="Article body" className="flex gap-1 border-b border-border">
              {(["write", "preview", ...(isOrgArticle ? (["history"] as const) : [])] as const).map((name) => (
                <button
                  key={name}
                  type="button"
                  role="tab"
                  aria-selected={tab === name}
                  onClick={() => setTab(name)}
                  className={cn("-mb-px border-b-2 px-3 py-1.5 text-sm", tab === name ? "border-brand font-medium text-fg" : "border-transparent text-fg-muted hover:text-fg")}
                >
                  {name === "write" ? "Markdown" : name === "preview" ? "Preview" : "Version history"}
                </button>
              ))}
            </div>
            {tab === "write" ? (
              <Textarea value={draft.body} onChange={(e) => set("body", e.target.value)} rows={16} className="font-mono text-xs" aria-label="Article body (Markdown)" />
            ) : tab === "preview" ? (
              <div className="min-h-64 rounded-md border border-border p-4">
                <HelpMarkdown text={draft.body} />
              </div>
            ) : (
              <Revisions id={editId} onRestored={onClose} />
            )}
          </form>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="kb-article" disabled={!draft || save.isPending}>
            {draft?.status === "published" ? "Save and publish" : "Save draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const MODULES = ["Getting Started", "Dashboard", "Pipeline", "Contacts", "Activities", "AI Assistant", "Helpdesk", "Products", "Settings", "FAQ"];

function newDraft(question?: HelpUnanswered): Draft {
  if (!question) return { ...EMPTY };
  const text = question.question.trim().replace(/\?*$/, "?");
  return { ...EMPTY, title: question.question.trim().replace(/\?+$/, ""), question: text, route: question.page || "/dashboard" };
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-fg-subtle">{hint}</p> : null}
    </div>
  );
}

function Revisions({ id, onRestored }: { id: string; onRestored: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery({ queryKey: crmKeys.helpRevisions(id), queryFn: () => listHelpRevisions(id) });
  const restore = useMutation({
    mutationFn: (version: number) => restoreHelpRevision(id, version),
    onSuccess: (saved) => {
      toast({ tone: "success", title: `Restored as version ${saved.version}` });
      queryClient.invalidateQueries({ queryKey: ["help"] });
      onRestored();
    },
    onError: (err) => toast({ tone: "error", title: "Could not restore", description: errorMessage(err) }),
  });
  if (isPending) return <SkeletonRows rows={3} />;
  const rows = data?.results ?? [];
  return (
    <ul className="grid gap-1.5">
      {rows.map((rev, index) => (
        <li key={rev.version} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
          <History className="size-4 text-fg-subtle" aria-hidden />
          <span className="font-medium">v{rev.version}</span>
          <span className="text-fg-muted">{rev.title}</span>
          <StatusBadge status={rev.status} />
          <span className="text-xs text-fg-subtle">
            {formatDateTime(rev.created_at)}
            {rev.edited_by ? ` · ${rev.edited_by}` : ""}
          </span>
          {index > 0 ? (
            <Button variant="ghost" size="sm" className="ml-auto" disabled={restore.isPending} onClick={() => restore.mutate(rev.version)}>
              Restore
            </Button>
          ) : (
            <span className="ml-auto text-xs text-fg-subtle">Current</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function UnansweredTab({ onCreate }: { onCreate: (question: HelpUnanswered) => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = React.useState<HelpUnanswered["status"]>("open");
  const { data, isPending, isError, error } = useQuery({ queryKey: crmKeys.helpUnanswered(status), queryFn: () => listHelpUnanswered(status) });
  const update = useMutation({
    mutationFn: ({ id, next }: { id: string; next: HelpUnanswered["status"] }) => setHelpUnansweredStatus(id, next),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["help", "admin", "unanswered"] }),
    onError: (err) => toast({ tone: "error", title: "Could not update", description: errorMessage(err) }),
  });
  const rows = data?.results ?? [];
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-muted">Questions the guide had no article for.</p>
        <Select value={status} onValueChange={(value) => setStatus(value as HelpUnanswered["status"])}>
          <SelectTrigger className="h-8 w-40" aria-label="Show questions">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="answered">Answered</SelectItem>
            <SelectItem value="dismissed">Dismissed</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {isPending ? (
        <SkeletonRows rows={4} />
      ) : isError ? (
        <p className="text-sm text-danger">{errorMessage(error)}</p>
      ) : rows.length === 0 ? (
        <EmptyState icon={<MessageCircleQuestion />} title="Nothing here" description={status === "open" ? "Every question so far had an answer in the guide." : undefined} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Question</TableHead>
              <TableHead>Asked</TableHead>
              <TableHead>Page</TableHead>
              <TableHead>Last asked</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="max-w-md">{row.question}</TableCell>
                <TableCell>{row.times_asked}×</TableCell>
                <TableCell className="text-fg-muted">{row.page || "—"}</TableCell>
                <TableCell className="text-fg-muted">{formatDateTime(row.last_asked_at)}</TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  {row.status === "answered" ? (
                    <Link href={`/help/${encodeURIComponent(row.article_slug)}`} className="text-sm text-primary hover:underline">
                      View article
                    </Link>
                  ) : (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => onCreate(row)}>
                        Create article
                      </Button>
                      {row.status === "open" ? (
                        <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: row.id, next: "dismissed" })}>
                          Dismiss
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: row.id, next: "open" })}>
                          Reopen
                        </Button>
                      )}
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function ReportTab() {
  const [days, setDays] = React.useState("30");
  const { data, isPending, isError, error } = useQuery({ queryKey: [...crmKeys.helpReport, days], queryFn: () => getHelpReport(Number(days)) });
  if (isPending) return <SkeletonRows rows={6} />;
  if (isError || !data) return <p className="text-sm text-danger">{errorMessage(error)}</p>;
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-muted">
          {data.unanswered_open} open unanswered question{data.unanswered_open === 1 ? "" : "s"}.
        </p>
        <Select value={days} onValueChange={setDays}>
          <SelectTrigger className="h-8 w-36" aria-label="Period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <ReportTable title="Most asked" rows={data.most_asked} empty="No help questions in this period." />
        <ReportTable title="Lowest rated" rows={data.lowest_rated} empty="No answer was rated unhelpful in this period." />
      </div>
      <section aria-labelledby="kb-comments" className="grid gap-2">
        <h2 id="kb-comments" className="text-sm font-semibold text-fg">
          Recent comments
        </h2>
        {data.recent_comments.length === 0 ? (
          <p className="text-sm text-fg-muted">No comments yet.</p>
        ) : (
          <ul className="grid gap-2">
            {data.recent_comments.map((c, index) => (
              <li key={index} className="rounded-md border border-border px-3 py-2 text-sm">
                <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
                  {c.rating === 1 ? <ThumbsUp className="size-3.5 text-brand" aria-label="Helpful" /> : <ThumbsDown className="size-3.5 text-danger" aria-label="Not helpful" />}
                  {c.article_id || "No article"} · {formatDateTime(c.created_at)}
                </p>
                <p className="mt-1 text-fg-muted">“{c.question}”</p>
                <p className="mt-0.5 text-fg">{c.comment}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ReportTable({ title, rows, empty }: { title: string; rows: { id: string; title: string; asked: number; helpful: number; unhelpful: number }[]; empty: string }) {
  return (
    <section aria-label={title} className="grid gap-2">
      <h2 className="text-sm font-semibold text-fg">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">{empty}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Article</TableHead>
              <TableHead>Asked</TableHead>
              <TableHead>
                <ThumbsUp className="size-3.5" aria-label="Helpful" />
              </TableHead>
              <TableHead>
                <ThumbsDown className="size-3.5" aria-label="Not helpful" />
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <Link href={`/help/${encodeURIComponent(row.id)}`} className="hover:underline">
                    {row.title}
                  </Link>
                </TableCell>
                <TableCell>{row.asked}</TableCell>
                <TableCell>{row.helpful}</TableCell>
                <TableCell>{row.unhelpful}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
