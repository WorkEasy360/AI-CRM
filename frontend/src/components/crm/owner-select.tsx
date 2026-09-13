"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listMembers } from "@/lib/api/endpoints";
import { queryKeys } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";

/** Member picker for record ownership. Render only when `canReassign` is true; the API re-checks. */
export function OwnerSelect({
  id,
  value,
  onChange,
  disabled,
  ariaInvalid,
}: {
  id?: string;
  value: string | null | undefined;
  onChange: (id: string) => void;
  disabled?: boolean;
  ariaInvalid?: boolean;
}) {
  const members = useCursorList(queryKeys.members, listMembers);
  const active = members.items.filter((m) => m.status === "active");
  return (
    <Select value={value ?? ""} onValueChange={onChange} disabled={disabled || members.isPending}>
      <SelectTrigger id={id} aria-label="Owner" aria-invalid={ariaInvalid || undefined}>
        <SelectValue placeholder={members.isPending ? "Loading…" : "Choose an owner"} />
      </SelectTrigger>
      <SelectContent>
        {active.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.user.display_name || m.user.email}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
