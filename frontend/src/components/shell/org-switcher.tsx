"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, ChevronsUpDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { switchOrganization } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/problem";
import type { Session } from "@/lib/api/types";

export function OrgSwitcher({ session }: { session: Session }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const active = session.active;

  const switchMutation = useMutation({
    mutationFn: switchOrganization,
    onSuccess: async () => {
      // Everything is scoped to the organisation: drop all cached data.
      await queryClient.invalidateQueries();
      router.push("/dashboard");
    },
    onError: (error) => toast({ tone: "error", title: "Could not switch organization", description: errorMessage(error) }),
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="max-w-56 justify-between gap-2 px-2 font-semibold" aria-label="Switch organization">
          <Building2 className="size-4 shrink-0 text-fg-subtle" />
          <span className="truncate">{active?.organization.name ?? "Select organization"}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-fg-subtle" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={active?.membership_id}
          onValueChange={(membership_id) => {
            if (membership_id !== active?.membership_id) switchMutation.mutate(membership_id);
          }}
        >
          {session.memberships.map((m) => (
            <DropdownMenuRadioItem key={m.id} value={m.id} disabled={m.status !== "active" || switchMutation.isPending}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{m.organization.name}</span>
                <span className="truncate text-xs text-fg-subtle">
                  {m.role.name}
                  {m.status !== "active" ? ` · ${m.status}` : ""}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push("/onboarding/create-organization")}>
          <Plus /> New organization
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
