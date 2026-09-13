"use client";

import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Lock, LogOut } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/components/ui/toast";
import { logout } from "@/lib/api/allauth";
import { errorMessage } from "@/lib/api/problem";
import type { Session } from "@/lib/api/types";

export function UserMenu({ session }: { session: Session }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.clear();
      router.replace("/login");
    },
    onError: (error) => toast({ tone: "error", title: "Sign out failed", description: errorMessage(error) }),
  });

  const name = session.user.display_name || session.user.email;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account menu">
          <Avatar name={name} size="sm" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="normal-case tracking-normal">
          <span className="block truncate text-sm font-medium text-fg">{name}</span>
          <span className="block truncate text-xs font-normal text-fg-subtle">{session.user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push("/settings/security")}>
          <Lock /> Security
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => logoutMutation.mutate()} disabled={logoutMutation.isPending}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
