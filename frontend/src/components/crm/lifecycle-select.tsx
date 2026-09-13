"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Loader2 } from "lucide-react";
import { LifecycleBadge, lifecycleVariant } from "@/components/crm/lifecycle-badge";
import { isVersionConflict } from "@/components/crm/use-record-mutations";
import { badgeVariants } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { updateCompany, updateContact } from "@/lib/api/crm";
import { LIFECYCLE_LABELS, LIFECYCLE_STAGES, type Company, type Contact, type LifecycleStage } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";
import { cn } from "@/lib/utils";

const ALL = "__all__";

/** Plain status select for forms and filters. Pass `allowAll` to add an "All statuses" option (value ""). */
export function LifecycleSelect({
  value,
  onChange,
  disabled,
  id,
  className,
  allowAll = false,
  ariaLabel,
  ariaInvalid,
  ariaDescribedBy,
}: {
  value: LifecycleStage | "" | undefined;
  onChange: (value: LifecycleStage | "") => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  allowAll?: boolean;
  ariaLabel?: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
}) {
  return (
    <Select value={value || (allowAll ? ALL : "lead")} onValueChange={(v) => onChange(v === ALL ? "" : (v as LifecycleStage))} disabled={disabled}>
      <SelectTrigger id={id} className={className} aria-label={ariaLabel} aria-invalid={ariaInvalid || undefined} aria-describedby={ariaDescribedBy}>
        <SelectValue placeholder="Status" />
      </SelectTrigger>
      <SelectContent>
        {allowAll ? <SelectItem value={ALL}>All statuses</SelectItem> : null}
        {LIFECYCLE_STAGES.map((s) => (
          <SelectItem key={s} value={s}>
            {allowAll ? `${LIFECYCLE_LABELS[s]}s` : LIFECYCLE_LABELS[s]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Inline status changer for record headers: renders the current badge as a menu trigger and PATCHes
 * `lifecycle_stage` with the record's `version`, then refreshes the record, its lists and timeline.
 */
export function LifecycleStatusChanger({
  entity,
  record,
  disabled,
  className,
}: {
  entity: "contact" | "company";
  record: { id: string; version: number; lifecycle_stage: LifecycleStage };
  disabled?: boolean;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const path = entity === "contact" ? "contacts" : "companies";

  const mutation = useMutation<Contact | Company, unknown, LifecycleStage>({
    mutationFn: (stage) =>
      entity === "contact"
        ? updateContact(record.id, record.version, { lifecycle_stage: stage })
        : updateCompany(record.id, record.version, { lifecycle_stage: stage }),
    onSuccess: async (saved, stage) => {
      queryClient.setQueryData(crmKeys.record(path, record.id), saved);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: crmKeys.record(path, record.id) }),
        queryClient.invalidateQueries({ queryKey: ["crm", path, "list"] }),
        queryClient.invalidateQueries({ queryKey: ["crm", path, "stats"] }),
        queryClient.invalidateQueries({ queryKey: crmKeys.timeline(entity, record.id) }),
      ]);
      toast({ tone: "success", title: "Status updated", description: `Now marked as ${LIFECYCLE_LABELS[stage].toLowerCase()}.` });
    },
    onError: async (err) => {
      if (isVersionConflict(err)) {
        await queryClient.invalidateQueries({ queryKey: crmKeys.record(path, record.id) });
        toast({ tone: "error", title: "This record was changed by someone else", description: "The latest version was loaded. Try again." });
        return;
      }
      toast({ tone: "error", title: "Could not update status", description: errorMessage(err) });
    },
  });

  if (disabled) return <LifecycleBadge stage={record.lifecycle_stage} className={className} />;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            badgeVariants({ variant: lifecycleVariant(record.lifecycle_stage) }),
            "cursor-pointer pr-1.5 transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-ring/40 disabled:opacity-60",
            className,
          )}
          aria-label={`Status: ${LIFECYCLE_LABELS[record.lifecycle_stage]}. Change status`}
          disabled={mutation.isPending}
        >
          {LIFECYCLE_LABELS[record.lifecycle_stage]}
          {mutation.isPending ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <ChevronDown className="size-3" aria-hidden />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-40">
        <DropdownMenuLabel>Status</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={record.lifecycle_stage} onValueChange={(v) => v !== record.lifecycle_stage && mutation.mutate(v as LifecycleStage)}>
          {LIFECYCLE_STAGES.map((stage) => (
            <DropdownMenuRadioItem key={stage} value={stage}>
              <LifecycleBadge stage={stage} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
