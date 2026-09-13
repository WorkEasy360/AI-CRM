"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { findCompanyDuplicates, findContactDuplicates } from "@/lib/api/crm";
import type { CompanyDuplicate, ContactDuplicate } from "@/lib/api/crm-types";
import { useDebounced } from "@/lib/crm/use-list-params";
import { cn } from "@/lib/utils";

export const DUPLICATE_DEBOUNCE_MS = 400;

export interface DuplicateHit {
  id: string;
  name: string;
  /** Secondary text, e.g. the matching email or website. */
  detail: string;
  href: string;
}

/** Compact amber notice listing possible duplicates. Never blocks saving; it only links to the records. */
export function DuplicateWarning({ hits, className }: { hits: DuplicateHit[]; className?: string }) {
  if (hits.length === 0) return null;
  const shown = hits.slice(0, 3);
  const extra = hits.length - shown.length;
  return (
    <div
      role="status"
      className={cn("flex items-start gap-2 rounded-sm border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-warning", className)}
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <ul className="flex min-w-0 flex-1 flex-col gap-0.5">
        {shown.map((hit) => (
          <li key={hit.id} className="flex flex-wrap items-center gap-x-1">
            <span>
              Possible duplicate: <span className="font-medium">{hit.name}</span>
              {hit.detail ? <span> ({hit.detail})</span> : null}
            </span>
            <span aria-hidden>—</span>
            <Link href={hit.href} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2 hover:opacity-80">
              Open
            </Link>
          </li>
        ))}
        {extra > 0 ? <li className="text-warning/80">and {extra} more</li> : null}
      </ul>
    </div>
  );
}

/**
 * Debounced, cancellable lookup. `key` must change when the inputs change; an empty key skips the
 * request and clears the result. Errors are swallowed on purpose: a failed hint must not get in the way.
 */
function useDuplicateLookup<T>(key: string, fetcher: (signal: AbortSignal) => Promise<{ results: T[] }>) {
  const debounced = useDebounced(key, DUPLICATE_DEBOUNCE_MS);
  const [results, setResults] = React.useState<T[]>([]);
  const fetcherRef = React.useRef(fetcher);
  fetcherRef.current = fetcher;

  React.useEffect(() => {
    if (!debounced) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    fetcherRef
      .current(controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) setResults(res.results);
      })
      .catch(() => {
        if (!controller.signal.aborted) setResults([]);
      });
    return () => controller.abort();
  }, [debounced]);

  return results;
}

const enc = encodeURIComponent;

function contactDetail(d: ContactDuplicate): string {
  if (d.matched_on.includes("email") && d.email) return d.email;
  if (d.matched_on.includes("phone") && d.phone) return d.phone;
  return d.email || d.phone || d.company?.name || "";
}

/**
 * Watches the name/email/phone a user types in the contact form and warns about likely duplicates.
 * `exclude` is the id of the record being edited; pass `enabled=false` until the values changed.
 */
export function ContactDuplicateCheck({
  firstName,
  lastName,
  email,
  phone,
  exclude,
  enabled = true,
  className,
}: {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  exclude?: string;
  enabled?: boolean;
  className?: string;
}) {
  const first = firstName.trim();
  const last = lastName.trim();
  const mail = email.trim();
  const tel = phone.trim();
  // Names only count when both parts are present; a lone first name would match half the book.
  const nameReady = Boolean(first && last);
  const ready = enabled && (mail.length >= 3 || tel.length >= 5 || nameReady);
  const key = ready ? JSON.stringify({ first: nameReady ? first : "", last: nameReady ? last : "", mail, tel, exclude }) : "";
  const results = useDuplicateLookup<ContactDuplicate>(key, (signal) =>
    findContactDuplicates(
      {
        email: mail || undefined,
        phone: tel || undefined,
        first_name: nameReady ? first : undefined,
        last_name: nameReady ? last : undefined,
        exclude,
      },
      signal,
    ),
  );
  const hits = React.useMemo<DuplicateHit[]>(
    () => results.map((d) => ({ id: d.id, name: d.display_name || d.email || "Unnamed contact", detail: contactDetail(d), href: `/contacts/${enc(d.id)}` })),
    [results],
  );
  return <DuplicateWarning hits={hits} className={className} />;
}

function companyDetail(d: CompanyDuplicate): string {
  if (d.matched_on.includes("website") && d.website) return d.website;
  return d.website || d.industry || "";
}

/** Same as ContactDuplicateCheck, for the company form (name / website). */
export function CompanyDuplicateCheck({
  name,
  website,
  exclude,
  enabled = true,
  className,
}: {
  name: string;
  website: string;
  exclude?: string;
  enabled?: boolean;
  className?: string;
}) {
  const n = name.trim();
  const w = website.trim();
  const ready = enabled && (n.length >= 2 || w.length >= 4);
  const key = ready ? JSON.stringify({ n, w, exclude }) : "";
  const results = useDuplicateLookup<CompanyDuplicate>(key, (signal) =>
    findCompanyDuplicates({ name: n || undefined, website: w || undefined, exclude }, signal),
  );
  const hits = React.useMemo<DuplicateHit[]>(
    () => results.map((d) => ({ id: d.id, name: d.name, detail: companyDetail(d), href: `/companies/${enc(d.id)}` })),
    [results],
  );
  return <DuplicateWarning hits={hits} className={className} />;
}
