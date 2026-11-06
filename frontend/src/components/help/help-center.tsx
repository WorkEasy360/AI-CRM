"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, BookOpen, Lock, Search, Sparkles } from "lucide-react";
import { useAssistant } from "@/components/assistant/ask-keel";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { SkeletonRows } from "@/components/ui/skeleton";
import { getHelpArticle, listHelpArticles } from "@/lib/api/crm";
import type { HelpArticleSummary } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { spotlight } from "@/lib/spotlight";
import { cn } from "@/lib/utils";
import { ArticleBody } from "./help-answer";
import { Inline, MenuPath } from "./markdown";

/** Every help article, searchable and grouped by module. The same articles WorkEasy AI answers from. */
export function HelpCenterPage() {
  const [query, setQuery] = React.useState("");
  const [module, setModule] = React.useState("");
  const deferred = React.useDeferredValue(query.trim());
  const { data, isPending, isError, error } = useQuery({
    queryKey: crmKeys.helpArticles(deferred),
    queryFn: () => listHelpArticles(deferred ? { q: deferred } : undefined),
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
  });
  const assistant = useAssistant();

  const results = React.useMemo(() => (data?.results ?? []).filter((a) => !module || a.module === module), [data, module]);
  const groups = React.useMemo(() => {
    const byModule = new Map<string, HelpArticleSummary[]>();
    for (const article of results) byModule.set(article.module, [...(byModule.get(article.module) ?? []), article]);
    return (data?.modules ?? []).filter((m) => byModule.has(m)).map((m) => ({ module: m, articles: byModule.get(m) ?? [] }));
  }, [results, data]);

  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <PageHeader
        icon={BookOpen}
        title="Help Center"
        description="Step-by-step guides for every part of WorkEasy360."
        actions={
          assistant?.available ? (
            <Button variant="secondary" size="sm" onClick={() => assistant.openPanel()} className="gap-1.5">
              <Sparkles className="size-4" aria-hidden /> Ask WorkEasy AI
            </Button>
          ) : null
        }
      />

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search the guide, e.g. create a pipeline, import contacts, 2FA"
          aria-label="Search the help guide"
          className="h-11 pl-9"
          maxLength={200}
        />
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by module">
        {["", ...(data?.modules ?? [])].map((m) => (
          <button
            key={m || "all"}
            type="button"
            aria-pressed={module === m}
            onClick={() => setModule(m)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              module === m ? "border-[#15803d] bg-[#15803d] text-white" : "border-border text-fg-muted hover:bg-bg-subtle hover:text-fg",
            )}
          >
            {m || "All topics"}
          </button>
        ))}
      </div>

      {isPending ? (
        <SkeletonRows rows={6} />
      ) : isError ? (
        <p className="text-sm text-danger">{errorMessage(error)}</p>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={<Search />}
          title="No guide matches that yet"
          description="Try other words, or ask WorkEasy AI. Questions it cannot answer are shared with your workspace admins."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {groups.map((group) => (
            <section key={group.module} aria-labelledby={`help-${group.module}`} className="rounded-xl border border-border bg-surface p-4">
              <h2 id={`help-${group.module}`} className="mb-2 text-sm font-semibold text-fg">
                {group.module} <span className="font-normal text-fg-subtle">({group.articles.length})</span>
              </h2>
              <ul className="grid gap-0.5">
                {group.articles.map((article) => (
                  <li key={article.id}>
                    <Link
                      href={`/help/${encodeURIComponent(article.id)}`}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg-muted transition-colors hover:bg-bg-subtle hover:text-fg"
                    >
                      <span className="min-w-0 flex-1 truncate">{article.title}</span>
                      {article.permission_ok ? null : <Lock className="size-3.5 shrink-0 text-fg-subtle" aria-label="Needs a permission your role does not have" />}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export function HelpArticlePage({ id }: { id: string }) {
  const router = useRouter();
  const assistant = useAssistant();
  const { data, isPending, isError, error } = useQuery({
    queryKey: crmKeys.helpArticle(id),
    queryFn: () => getHelpArticle(id),
    staleTime: 5 * 60_000,
  });

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <Link href="/help" className="flex w-fit items-center gap-1 text-sm text-fg-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden /> Help Center
      </Link>
      {isPending ? (
        <SkeletonRows rows={8} />
      ) : isError || !data ? (
        <EmptyState icon={<BookOpen />} title="Guide not found" description={errorMessage(error)} />
      ) : (
        <article className="grid gap-4 rounded-xl border border-border bg-surface p-5">
          <header className="grid gap-2">
            <p className="text-xs font-medium text-fg-subtle">{data.article.module}</p>
            <h1 className="text-xl font-bold tracking-tight text-fg">{data.article.title}</h1>
            <p className="text-sm leading-relaxed text-fg-muted">
              <Inline text={data.content.overview} />
            </p>
            {data.article.menu_path ? <MenuPath path={data.article.menu_path} /> : null}
          </header>
          {!data.article.permission_ok ? (
            <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-fg">
              <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Your role doesn&apos;t include this feature. Contact your workspace admin to get access.
            </p>
          ) : null}
          <ArticleBody content={data.content} />
          {data.content.troubleshooting.length > 0 ? (
            <section aria-label="Troubleshooting" className="grid gap-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Troubleshooting</p>
              <ul className="grid gap-1 text-sm text-fg-muted">
                {data.content.troubleshooting.map((item, index) => (
                  <li key={index}>
                    <Inline text={item} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => {
                router.push(data.article.route);
                if (data.article.spotlight) spotlight(data.article.spotlight);
              }}
            >
              Take me there <ArrowRight className="size-4" aria-hidden />
            </Button>
            {assistant?.available ? (
              <Button variant="secondary" size="sm" className="gap-1.5" onClick={() => assistant.submit(data.article.question)}>
                <Sparkles className="size-4" aria-hidden /> Ask WorkEasy AI about this
              </Button>
            ) : null}
          </div>
          {data.related.length > 0 ? (
            <footer className="grid gap-1.5 border-t border-border pt-3">
              <p className="text-xs font-medium text-fg-subtle">Related topics</p>
              <div className="flex flex-wrap gap-1.5">
                {data.related.map((item) => (
                  <Link
                    key={item.id}
                    href={`/help/${encodeURIComponent(item.id)}`}
                    className="rounded-full border border-border px-2.5 py-1 text-xs text-fg-muted hover:bg-bg-subtle hover:text-fg"
                  >
                    {item.title}
                  </Link>
                ))}
              </div>
            </footer>
          ) : null}
        </article>
      )}
    </div>
  );
}
