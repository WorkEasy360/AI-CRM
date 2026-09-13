"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Users } from "lucide-react";
import { Section } from "@/components/crm/record-page";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { FormError } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { addDealContact, dealContacts, listContacts, removeDealContact } from "@/lib/api/crm";
import type { Deal } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";

/** People linked to a deal with their role; link / unlink when editable. */
export function DealContactsSection({ deal, editable }: { deal: Deal; editable: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const links = useQuery({ queryKey: crmKeys.dealContacts(deal.id), queryFn: () => dealContacts(deal.id) });
  const [adding, setAdding] = React.useState(false);
  const [contactId, setContactId] = React.useState("");
  const [roleLabel, setRoleLabel] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const contactParams = React.useMemo(() => ({ sort: "name", ...(deal.company ? { company: deal.company.id } : {}) }), [deal.company]);
  const contacts = useQuery({
    queryKey: crmKeys.list("contacts", { ...contactParams, picker: "deal-link" }),
    queryFn: () => listContacts(contactParams),
    enabled: adding,
    staleTime: 60_000,
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: crmKeys.dealContacts(deal.id) }),
      queryClient.invalidateQueries({ queryKey: crmKeys.record("deals", deal.id) }),
      queryClient.invalidateQueries({ queryKey: crmKeys.timeline("deal", deal.id) }),
    ]);

  const add = useMutation({
    mutationFn: () => addDealContact(deal.id, contactId, roleLabel.trim()),
    onSuccess: async () => {
      await refresh();
      setAdding(false);
      setContactId("");
      setRoleLabel("");
      setError(null);
    },
    onError: (err) => setError(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => removeDealContact(deal.id, id),
    onSuccess: refresh,
    onError: (err) => toast({ tone: "error", title: "Could not remove contact", description: errorMessage(err) }),
  });

  const items = links.data?.results ?? [];
  const linkedIds = new Set(items.map((l) => l.contact.id));
  const options = (contacts.data?.results ?? []).filter((c) => !linkedIds.has(c.id));
  const roleId = React.useId();
  const contactSelectId = React.useId();

  return (
    <Section
      title="Contacts"
      actions={
        editable ? (
          <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
            <Plus /> Link contact
          </Button>
        ) : undefined
      }
    >
      {links.isPending ? (
        <SkeletonRows rows={2} />
      ) : links.isError ? (
        <p className="text-sm text-danger">{errorMessage(links.error)}</p>
      ) : items.length === 0 ? (
        <EmptyState icon={<Users />} title="No linked contacts" description="Link the people involved in this deal and note their role." className="py-8" />
      ) : (
        <ul className="divide-y divide-border">
          {items.map((link) => (
            <li key={link.id} className="flex items-center gap-3 py-2">
              <Avatar name={link.contact.name} size="sm" />
              <div className="min-w-0 flex-1">
                <Link href={`/contacts/${encodeURIComponent(link.contact.id)}`} className="block truncate text-sm font-medium hover:text-primary hover:underline">
                  {link.contact.name}
                </Link>
                <div className="truncate text-xs text-fg-subtle">{[link.role_label, link.contact.email].filter(Boolean).join(" · ")}</div>
              </div>
              {deal.primary_contact?.id === link.contact.id ? <span className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Primary</span> : null}
              {editable ? (
                <Button
                  variant="danger-ghost"
                  size="sm"
                  onClick={() => remove.mutate(link.contact.id)}
                  loading={remove.isPending && remove.variables === link.contact.id}
                  aria-label={`Unlink ${link.contact.name}`}
                >
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={adding}
        onOpenChange={(open) => {
          setAdding(open);
          if (!open) setError(null);
        }}
      >
        <DialogContent>
          <form
            className="grid gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!contactId) {
                setError("Choose a contact.");
                return;
              }
              add.mutate();
            }}
          >
            <DialogHeader>
              <DialogTitle>Link a contact</DialogTitle>
              <DialogDescription>{deal.company ? `Showing contacts at ${deal.company.name}.` : "Choose a contact and describe their role."}</DialogDescription>
            </DialogHeader>
            <FormError message={error} />
            <div className="flex flex-col gap-1.5">
              <label htmlFor={contactSelectId} className="text-sm font-medium">
                Contact
              </label>
              <Select value={contactId} onValueChange={setContactId}>
                <SelectTrigger id={contactSelectId}>
                  <SelectValue placeholder={contacts.isPending ? "Loading…" : "Choose a contact"} />
                </SelectTrigger>
                <SelectContent>
                  {options.length === 0 && !contacts.isPending ? <div className="px-2 py-1.5 text-sm text-fg-muted">No more contacts to link.</div> : null}
                  {options.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.display_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={roleId} className="text-sm font-medium">
                Role (optional)
              </label>
              <Input id={roleId} value={roleLabel} onChange={(e) => setRoleLabel(e.target.value)} maxLength={60} placeholder="Decision maker, Champion, Legal…" />
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button type="submit" loading={add.isPending}>
                Link contact
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
