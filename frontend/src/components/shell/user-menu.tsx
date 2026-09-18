"use client";

import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Building2, Lock, Moon, Settings, Sun, SunMoon } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
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
import { DEFAULT_NEXT } from "@/lib/safe-next";
import { useTheme, type ThemePreference } from "@/lib/theme";

const THEMES: { value: ThemePreference; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: SunMoon },
];

export function UserMenu({ session }: { session: Session }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { preference, setPreference } = useTheme();
  const active = session.active;
  const name = session.user.display_name || session.user.email;
  const switchable = session.memberships.filter((m) => m.status === "active");

  const switchMutation = useMutation({
    mutationFn: switchOrganization,
    onSuccess: async () => {
      // Everything is scoped to the organization: drop all cached data.
      await queryClient.invalidateQueries();
      router.push(DEFAULT_NEXT);
    },
    onError: (error) => toast({ tone: "error", title: "Could not switch organization", description: errorMessage(error) }),
  });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Account menu">
          <Avatar name={name} size="sm" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="normal-case tracking-normal">
          <span className="block truncate text-sm font-medium text-fg">{name}</span>
          <span className="block truncate text-xs font-normal text-fg-subtle">{session.user.email}</span>
          {active ? (
            <span className="mt-1 block truncate text-xs font-normal text-fg-muted">
              {active.organization.name} · {active.role.name}
            </span>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push("/settings/security")}>
          <Lock /> Profile &amp; security
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => router.push("/settings")}>
          <Settings /> Settings
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={preference} onValueChange={(v) => setPreference(v as ThemePreference)}>
          {THEMES.map((t) => (
            <DropdownMenuRadioItem key={t.value} value={t.value}>
              <span className="inline-flex items-center gap-2">
                <t.icon className="size-4 text-fg-subtle" aria-hidden /> {t.label}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {switchable.length > 1 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Organization</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={active?.membership_id}
              onValueChange={(membership_id) => {
                if (membership_id !== active?.membership_id) switchMutation.mutate(membership_id);
              }}
            >
              {switchable.map((m) => (
                <DropdownMenuRadioItem key={m.id} value={m.id} disabled={switchMutation.isPending}>
                  <span className="inline-flex min-w-0 items-center gap-2">
                    <Building2 className="size-4 shrink-0 text-fg-subtle" aria-hidden />
                    <span className="truncate">{m.organization.name}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        ) : null}
        {/* No "Sign out": there is no sign-in page to come back to, so signing out would only
            hand the visitor the same session again on the next request. */}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
