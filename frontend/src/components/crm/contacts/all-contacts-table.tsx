"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, MessageCircle, MoreVertical, Search, Star, UserRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { listCompanies, listContacts, setFavorite } from "@/lib/api/crm";
import type { Company, Contact, ListParams, TagRef } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { colorClasses } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import { useDebounced } from "@/lib/crm/use-list-params";
import { useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { cn, initials } from "@/lib/utils";

const ALL = "__all__";
/** Initials discs in a fixed order by the name, so a person keeps their colour across lists. */
const AVATAR_TINTS = ["bg-brand", "bg-[#7e22ce]", "bg-[#c2410c]", "bg-[#1d4ed8]", "bg-[#0f766e]", "bg-[#be185d]"];

export interface DirectoryRow {
  kind: "contact" | "company";
  id: string;
  name: string;
  company: string;
  phone: string;
  email: string;
  tags: TagRef[];
  lastActivity: string | null;
  updatedAt: string;
  favorite: boolean;
  href: string;
}

export function toRows(contacts: Contact[], companies: Company[]): DirectoryRow[] {
  const rows: DirectoryRow[] = [
    ...contacts.map((c) => ({
      kind: "contact" as const,
      id: c.id,
      name: c.display_name || c.email || "Unnamed contact",
      company: c.company?.name ?? "",
      phone: c.phone,
      email: c.email,
      tags: c.tags ?? [],
      lastActivity: c.last_activity_at ?? null,
      updatedAt: c.updated_at,
      favorite: Boolean(c.is_favorite),
      href: `/contacts/${encodeURIComponent(c.id)}`,
    })),
    ...companies.map((c) => ({
      kind: "company" as const,
      id: c.id,
      name: c.name,
      company: c.name,
      phone: c.phone,
      email: "",
      tags: c.tags ?? [],
      lastActivity: c.last_activity_at ?? null,
      updatedAt: c.updated_at,
      favorite: Boolean(c.is_favorite),
      href: `/companies/${encodeURIComponent(c.id)}`,
    })),
  ];
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** "Today", "Yesterday", else the date ("30 Oct"). */
export function lastActivityLabel(value: string | null, now: Date = new Date()): string {
  if (!value) return "—";
  const d = new Date(value);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { day: "2-digit", month: "short" }).format(d);
}

function NameCell({ row }: { row: DirectoryRow }) {
  const tint = AVATAR_TINTS[[...row.name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % AVATAR_TINTS.length];
  return (
    <Link href={row.href} className="inline-flex min-w-0 items-center gap-2.5 font-semibold text-fg hover:text-primary">
      {row.kind === "company" ? (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent" aria-hidden>
          <Building2 className="size-4" />
        </span>
      ) : (
        <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white", tint)} aria-hidden>
          {initials(row.name)}
        </span>
      )}
      <span className="truncate">{row.name}</span>
      {row.favorite ? <Star className="size-3.5 shrink-0 fill-[#f59e0b] text-[#f59e0b]" aria-label="Favorite" /> : null}
    </Link>
  );
}

/**
 * People and companies in one list (All Contacts, Favorites, a tag). Both lists page in together and the
 * rows interleave by last update; each list keeps its own scope, so nothing appears that its page would hide.
 */
export function AllContactsTable({ favorites = false, tagId }: { favorites?: boolean; tagId?: string }) {
  const router = useRouter();
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = React.useState("");
  const q = useDebounced(draft.trim(), 300);
  const [type, setType] = React.useState<"all" | "contact" | "company">("all");
  const canContacts = can(active, "contacts.view");
  const canCompanies = can(active, "companies.view");
  const params: ListParams = { sort: "-updated_at", ...(q ? { q } : {}), ...(favorites ? { favorite: "1" } : {}), ...(tagId ? { tag: tagId } : {}) };
  const contacts = useCursorList<Contact>(crmKeys.list("contacts", { ...params, directory: "1" }), (cursor) => listContacts(params, cursor), canContacts && type !== "company");
  const companies = useCursorList<Company>(crmKeys.list("companies", { ...params, directory: "1" }), (cursor) => listCompanies(params, cursor), canCompanies && type !== "contact");
  const rows = React.useMemo(() => toRows(type === "company" ? [] : contacts.items, type === "contact" ? [] : companies.items), [contacts.items, companies.items, type]);
  const pending = (canContacts && type !== "company" && contacts.isPending) || (canCompanies && type !== "contact" && companies.isPending);
  const error = contacts.isError ? contacts.error : companies.isError ? companies.error : null;
  const hasMore = (type !== "company" && contacts.hasMore) || (type !== "contact" && companies.hasMore);

  const star = useMutation({
    mutationFn: (row: DirectoryRow) => setFavorite(row.kind, row.id, !row.favorite),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["crm", "contacts"] });
      void queryClient.invalidateQueries({ queryKey: ["crm", "companies"] });
    },
    onError: (err) => toast({ tone: "error", title: "Could not update favourites", description: errorMessage(err) }),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Search contacts by name, company, phone, email…" aria-label="Search contacts" className="h-9 pl-8" maxLength={200} />
        </div>
        <Select value={type === "all" ? ALL : type} onValueChange={(v) => setType(v === ALL ? "all" : (v as "contact" | "company"))}>
          <SelectTrigger className="h-9 w-36" aria-label="Type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All Types</SelectItem>
            <SelectItem value="contact">Individuals</SelectItem>
            {canCompanies ? <SelectItem value="company">Companies</SelectItem> : null}
          </SelectContent>
        </Select>
      </div>

      <section aria-label="Contacts list" className="rounded-2xl border border-border bg-surface shadow-sm">
        {error ? (
          <EmptyState title="Could not load contacts" description={errorMessage(error)} />
        ) : pending ? (
          <div className="p-3">
            <SkeletonRows rows={6} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<UserRound />} title={favorites ? "No favourites yet" : q || tagId ? "No contacts match" : "No contacts yet"} description={favorites ? "Star a contact or company from its ⋮ menu to keep it here." : undefined} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="hidden lg:table-cell">Company Name</TableHead>
                <TableHead className="hidden md:table-cell">Phone</TableHead>
                <TableHead className="hidden xl:table-cell">Email</TableHead>
                <TableHead className="hidden lg:table-cell">Tags</TableHead>
                <TableHead className="hidden sm:table-cell">Last Activity</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={`${row.kind}:${row.id}`}>
                  <TableCell className="max-w-56">
                    <NameCell row={row} />
                  </TableCell>
                  <TableCell>
                    {row.kind === "company" ? (
                      <Badge className="gap-1 border-transparent bg-accent-soft text-accent">
                        <Building2 className="size-3" aria-hidden /> Company
                      </Badge>
                    ) : (
                      <Badge className="gap-1 border-transparent bg-brand-soft text-brand">
                        <UserRound className="size-3" aria-hidden /> Individual
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="hidden max-w-48 truncate lg:table-cell">{row.company || "—"}</TableCell>
                  <TableCell className="hidden whitespace-nowrap md:table-cell">
                    {row.phone ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Link href={row.href} aria-label={`WhatsApp ${row.name}`} className="text-[#16a34a] hover:text-brand">
                          <MessageCircle className="size-4" aria-hidden />
                        </Link>
                        {row.phone}
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="hidden max-w-56 truncate xl:table-cell">{row.email ? <a href={`mailto:${row.email}`} className="hover:text-primary hover:underline">{row.email}</a> : "—"}</TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <span className="flex flex-wrap gap-1">
                      {row.tags.slice(0, 2).map((t) => (
                        <span key={t.id} className={cn("rounded-full px-2 py-0.5 text-xs font-medium", colorClasses(t.color_token))}>
                          {t.name}
                        </span>
                      ))}
                      {row.tags.length > 2 ? <span className="text-xs text-fg-subtle">+{row.tags.length - 2}</span> : null}
                    </span>
                  </TableCell>
                  <TableCell className="hidden whitespace-nowrap sm:table-cell">{lastActivityLabel(row.lastActivity)}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.name}`}>
                          <MoreVertical />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => router.push(row.href)}>View</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => star.mutate(row)}>{row.favorite ? "Remove from favorites" : "Add to favorites"}</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {rows.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-sm text-fg-muted">
            <span>Showing 1–{rows.length.toLocaleString()} contacts</span>
            {hasMore ? (
              <Button
                variant="secondary"
                size="sm"
                loading={contacts.isLoadingMore || companies.isLoadingMore}
                onClick={() => {
                  if (type !== "company" && contacts.hasMore) void contacts.loadMore();
                  if (type !== "contact" && companies.hasMore) void companies.loadMore();
                }}
              >
                Load more
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
