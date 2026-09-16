"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ContactDuplicateCheck } from "@/components/crm/duplicate-warning";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createContact } from "@/lib/api/crm";
import type { NamedRef } from "@/lib/api/crm-types";
import { errorMessage, isApiError } from "@/lib/api/problem";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Split what the user typed into the picker into a first/last name to start from. */
export function splitName(input: string): { first: string; last: string } {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0]!, last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1]! };
}

/**
 * Creates a real Contact from inside the deal panel, so a person typed here is a record in
 * Contacts like any other — not a label that lives only on the deal. It is a plain <div>, not
 * a <form>, because it renders inside the deal form and forms cannot nest.
 */
export function InlineContactForm({
  initialName,
  companyId,
  onCancel,
  onCreated,
}: {
  initialName: string;
  /** Links the new contact to the deal's company when one is chosen. */
  companyId: string | null;
  onCancel: () => void;
  onCreated: (contact: NamedRef) => void;
}) {
  const seed = React.useMemo(() => splitName(initialName), [initialName]);
  const [first, setFirst] = React.useState(seed.first);
  const [last, setLast] = React.useState(seed.last);
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const queryClient = useQueryClient();
  const ids = React.useId();

  const create = useMutation({
    mutationFn: () =>
      createContact({
        first_name: first.trim(),
        last_name: last.trim(),
        email: email.trim(),
        phone: phone.trim(),
        company_id: companyId,
      }),
    onSuccess: async (contact) => {
      // The new contact must show up in the Contacts list straight away, not after a reload.
      // crmKeys.list builds ["crm", path, "list", params], so this prefix covers every contact list.
      await queryClient.invalidateQueries({ queryKey: ["crm", "contacts"] });
      onCreated({ id: contact.id, name: contact.display_name || contact.email || `${first} ${last}`.trim() });
    },
    onError: (err) => {
      if (isApiError(err) && err.isValidation) {
        const fields = err.fieldErrors();
        setError(Object.values(fields)[0] ?? "Check the contact details and try again.");
      } else {
        setError(errorMessage(err));
      }
    },
  });

  const submit = () => {
    setError(null);
    if (!first.trim() && !last.trim()) {
      setError("Enter at least a first or last name.");
      return;
    }
    if (email.trim() && !EMAIL.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    create.mutate();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  const field = (key: string, label: string, value: string, set: (v: string) => void, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`${ids}-${key}`}>{label}</Label>
      <Input
        id={`${ids}-${key}`}
        value={value}
        onChange={(e) => set(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={create.isPending}
        {...props}
      />
    </div>
  );

  return (
    <div className="grid gap-3 rounded-sm border border-border bg-bg-subtle p-3" role="group" aria-label="New contact">
      <p className="text-xs text-fg-muted">This creates a contact in your CRM and links it to the deal.</p>
      <FormError message={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        {field("first", "First name", first, setFirst, { autoFocus: true, maxLength: 120 })}
        {field("last", "Last name", last, setLast, { maxLength: 120 })}
        {field("email", "Email", email, setEmail, { type: "email", maxLength: 254, placeholder: "name@example.com" })}
        {field("phone", "Phone", phone, setPhone, { type: "tel", maxLength: 40, placeholder: "+1 555 0100" })}
      </div>
      <ContactDuplicateCheck firstName={first} lastName={last} email={email} phone={phone} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={create.isPending}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={submit} loading={create.isPending}>
          Add contact
        </Button>
      </div>
    </div>
  );
}
