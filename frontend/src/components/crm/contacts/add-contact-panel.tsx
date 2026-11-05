"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Info, UserRound, X } from "lucide-react";
import { RecordPicker } from "@/components/activities/pickers";
import { ContactDuplicateCheck } from "@/components/crm/duplicate-warning";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { createCompany, createContact, createTag, listTags, setRecordTags } from "@/lib/api/crm";
import type { NamedRef, TagRef } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";
import { colorClasses } from "@/lib/crm/format";
import { crmKeys } from "@/lib/crm/keys";
import { can } from "@/lib/crm/permissions";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import type { AddKind } from "./contacts-hub";

/** Dialling codes offered first; India is the default (WorkEasy360's home market). */
export const COUNTRY_CODES = [
  { code: "+91", label: "🇮🇳 +91" },
  { code: "+1", label: "🇺🇸 +1" },
  { code: "+44", label: "🇬🇧 +44" },
  { code: "+971", label: "🇦🇪 +971" },
  { code: "+65", label: "🇸🇬 +65" },
  { code: "+61", label: "🇦🇺 +61" },
] as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "Rahul Kumar Sharma" → first "Rahul", last "Kumar Sharma". */
export function splitName(full: string): { first_name: string; last_name: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  return { first_name: parts[0] ?? "", last_name: parts.slice(1).join(" ") };
}

/** "+91" and "98710 27926" → "+91 98710 27926"; a number typed with its own "+" is kept as typed. */
export function fullPhone(code: string, number: string): string {
  const n = number.trim();
  if (!n) return "";
  return n.startsWith("+") ? n : `${code} ${n}`;
}

export function validPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

/**
 * The WorkEasy360 "Add Contact" slide-over: an Individual or a Company, with the company chosen or created
 * inline, a dialling code (India by default), tags and notes. Duplicates are flagged as you type (never
 * blocking: the same person may be entered twice on purpose); every rule is enforced again by the API.
 */
export function AddContactPanel({ kind, onKindChange, onClose, onCreated }: { kind: AddKind; onKindChange: (kind: AddKind) => void; onClose: () => void; onCreated?: (href: string) => void }) {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = React.useState("");
  const [company, setCompany] = React.useState<NamedRef | null>(null);
  const [code, setCode] = React.useState<string>("+91");
  const [phone, setPhone] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [jobTitle, setJobTitle] = React.useState("");
  const [website, setWebsite] = React.useState("");
  const [tags, setTags] = React.useState<TagRef[]>([]);
  const [notes, setNotes] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const individual = kind === "individual";
  const canIndividual = can(active, "contacts.create");
  const canCompany = can(active, "companies.create");

  const companyCreate = useMutation({
    mutationFn: (value: string) => createCompany({ name: value }),
    onSuccess: (created) => {
      setCompany({ id: created.id, name: created.name });
      void queryClient.invalidateQueries({ queryKey: ["crm", "companies"] });
      toast({ tone: "success", title: "Company created", description: created.name });
    },
    onError: (err) => toast({ tone: "error", title: "Could not create the company", description: errorMessage(err) }),
  });

  const save = useMutation({
    mutationFn: async () => {
      const number = fullPhone(code, phone);
      if (individual) {
        const created = await createContact({ ...splitName(name), email: email.trim(), phone: number, job_title: jobTitle.trim(), company_id: company?.id ?? null, description: notes });
        if (tags.length) await setRecordTags("contacts", created.id, tags.map((t) => t.id));
        return `/contacts/${encodeURIComponent(created.id)}`;
      }
      const created = await createCompany({ name: name.trim(), phone: number, website: website.trim(), description: notes });
      if (tags.length) await setRecordTags("companies", created.id, tags.map((t) => t.id));
      return `/companies/${encodeURIComponent(created.id)}`;
    },
    onSuccess: (href) => {
      void queryClient.invalidateQueries({ queryKey: ["crm", "contacts"] });
      void queryClient.invalidateQueries({ queryKey: ["crm", "companies"] });
      toast({ tone: "success", title: individual ? "Contact saved" : "Company saved", description: name.trim() });
      onCreated?.(href);
      onClose();
    },
    onError: (err) => {
      if (isApiError(err) && err.isValidation) setErrors(err.fieldErrors());
      else toast({ tone: "error", title: "Could not save", description: errorMessage(err) });
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = individual ? "Enter the person's full name." : "Enter the company name.";
    if (individual && !phone.trim()) next.phone = "Enter a phone number.";
    if (phone.trim() && !validPhone(fullPhone(code, phone))) next.phone = "Enter a valid phone number (7 to 15 digits).";
    if (email.trim() && !EMAIL.test(email.trim())) next.email = "Enter a valid email address.";
    setErrors(next);
    if (Object.keys(next).length === 0) save.mutate();
  };

  const nameParts = splitName(name);
  const error = (key: string) =>
    errors[key] ? (
      <p role="alert" className="text-xs text-danger">
        {errors[key]}
      </p>
    ) : null;

  return (
    <Sheet open onOpenChange={(open) => (open ? null : onClose())}>
      <SheetContent side="right" className="w-[min(28rem,100%)] overflow-y-auto p-0">
        <form onSubmit={submit} className="flex min-h-full flex-col" noValidate>
          <div className="flex items-center justify-between px-5 pt-5">
            <SheetTitle className="text-lg font-bold text-fg">Add Contact</SheetTitle>
            <SheetDescription className="sr-only">Add an individual or a company</SheetDescription>
          </div>
          <div className="flex flex-1 flex-col gap-4 px-5 py-4">
            <div role="radiogroup" aria-label="Contact type" className="grid grid-cols-2 gap-2">
              {(
                [
                  ["individual", "Individual", "(Personal Contact)", UserRound, canIndividual],
                  ["company", "Company", "(Business / Organization)", Building2, canCompany],
                ] as const
              ).map(([value, label, hint, Icon, allowed]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={kind === value}
                  disabled={!allowed}
                  onClick={() => onKindChange(value)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50",
                    kind === value ? "border-brand bg-[#f0fdf4] ring-1 ring-brand" : "border-border hover:bg-bg-subtle",
                  )}
                >
                  <Icon className={cn("size-6 shrink-0", kind === value ? "text-brand" : "text-fg-muted")} aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-fg">{label}</span>
                    <span className="block truncate text-[11px] text-fg-muted">{hint}</span>
                  </span>
                </button>
              ))}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="ac-name">
                {individual ? "Full Name" : "Company Name"} <span className="text-danger">*</span>
              </Label>
              <Input id="ac-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={individual ? 241 : 200} autoFocus aria-invalid={Boolean(errors.name || errors.first_name) || undefined} />
              {error("name") ?? error("first_name")}
            </div>

            {individual ? (
              <div className="grid gap-1.5">
                <Label htmlFor="ac-company" className="inline-flex items-center gap-1">
                  Company Name (Optional) <Info className="size-3.5 text-fg-subtle" aria-label="A person can belong to one company" />
                </Label>
                <RecordPicker id="ac-company" entity="company" value={company} onChange={setCompany} placeholder="Search companies…" onCreate={(value) => companyCreate.mutate(value)} createLabel="Create company" creating={companyCreate.isPending} />
                <p className="flex items-start gap-2 rounded-md bg-[#f0fdf4] px-3 py-2 text-xs text-[#166534]">
                  <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  Select an existing company or create a new one. Multiple people can be linked to the same company.
                </p>
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
              <div className="grid gap-1.5">
                <Label htmlFor="ac-phone">
                  Phone {individual ? <span className="text-danger">*</span> : null}
                </Label>
                <div className="flex gap-1.5">
                  <Select value={code} onValueChange={setCode}>
                    <SelectTrigger className="w-24 shrink-0" aria-label="Country code">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COUNTRY_CODES.map((c) => (
                        <SelectItem key={c.code} value={c.code}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input id="ac-phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={32} placeholder="98710 27926" aria-invalid={Boolean(errors.phone) || undefined} />
                </div>
                {error("phone")}
              </div>
              {individual ? (
                <div className="grid gap-1.5">
                  <Label htmlFor="ac-email">Email</Label>
                  <Input id="ac-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} aria-invalid={Boolean(errors.email) || undefined} />
                  {error("email")}
                </div>
              ) : (
                <div className="grid gap-1.5">
                  <Label htmlFor="ac-website">Website</Label>
                  <Input id="ac-website" value={website} onChange={(e) => setWebsite(e.target.value)} maxLength={255} placeholder="apextech.in" />
                  {error("website")}
                </div>
              )}
            </div>

            {individual ? (
              <>
                <ContactDuplicateCheck firstName={nameParts.first_name} lastName={nameParts.last_name} email={email} phone={fullPhone(code, phone)} />
                <div className="grid gap-1.5">
                  <Label htmlFor="ac-title">Job Title / Designation</Label>
                  <Input id="ac-title" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} maxLength={120} />
                </div>
              </>
            ) : null}

            <TagChips value={tags} onChange={setTags} />

            <div className="grid gap-1.5">
              <Label htmlFor="ac-notes">Notes</Label>
              <Textarea id="ac-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} maxLength={5000} />
            </div>
          </div>
          <div className="sticky bottom-0 grid grid-cols-2 gap-3 border-t border-border bg-surface px-5 py-4">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending}>
              {individual ? "Save Contact" : "Save Company"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** Multi-select tag chips (removable with ✕); members who manage tags can create one by typing it. */
function TagChips({ value, onChange }: { value: TagRef[]; onChange: (tags: TagRef[]) => void }) {
  const { data: session } = useSession();
  const canManage = can(session?.active ?? null, "tags.manage");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const tags = useQuery({ queryKey: crmKeys.tags, queryFn: listTags, staleTime: 60_000 });
  const [draft, setDraft] = React.useState("");
  const chosen = new Set(value.map((t) => t.id));
  const options = (tags.data?.results ?? []).filter((t) => !chosen.has(t.id));
  const create = useMutation({
    mutationFn: (name: string) => createTag({ name }),
    onSuccess: (tag) => {
      onChange([...value, { id: tag.id, name: tag.name, color_token: tag.color_token }]);
      setDraft("");
      void queryClient.invalidateQueries({ queryKey: crmKeys.tags });
    },
    onError: (err) => toast({ tone: "error", title: "Could not create the tag", description: errorMessage(err) }),
  });
  const exact = (tags.data?.results ?? []).find((t) => t.name.toLowerCase() === draft.trim().toLowerCase());
  return (
    <div className="grid gap-1.5">
      <Label htmlFor="ac-tags">Tags</Label>
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-md border border-border-strong bg-surface px-2 py-1.5">
        {value.map((t) => (
          <span key={t.id} className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium", colorClasses(t.color_token))}>
            {t.name}
            <button type="button" aria-label={`Remove ${t.name}`} onClick={() => onChange(value.filter((x) => x.id !== t.id))} className="rounded-full hover:opacity-70">
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          id="ac-tags"
          list="ac-tag-options"
          value={draft}
          onChange={(e) => {
            const next = e.target.value;
            const match = options.find((t) => t.name === next);
            if (match) {
              onChange([...value, { id: match.id, name: match.name, color_token: match.color_token }]);
              setDraft("");
            } else setDraft(next);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !draft.trim()) return;
            e.preventDefault();
            if (exact && !chosen.has(exact.id)) {
              onChange([...value, { id: exact.id, name: exact.name, color_token: exact.color_token }]);
              setDraft("");
            } else if (!exact && canManage) create.mutate(draft.trim());
          }}
          placeholder={value.length ? "" : canManage ? "Pick a tag or type a new one" : "Pick a tag"}
          className="min-w-32 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-subtle"
          maxLength={40}
        />
        <datalist id="ac-tag-options">
          {options.map((t) => (
            <option key={t.id} value={t.name} />
          ))}
        </datalist>
      </div>
    </div>
  );
}
