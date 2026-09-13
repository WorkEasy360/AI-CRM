"use client";

import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { getSession } from "@/lib/api/endpoints";
import { isApiError } from "@/lib/api/problem";
import type { ActiveContext, PermissionScope, Session } from "@/lib/api/types";

export const queryKeys = {
  session: ["session"] as const,
  organization: ["organization", "current"] as const,
  roles: ["roles"] as const,
  members: ["members"] as const,
  invitations: ["invitations"] as const,
  teams: ["teams"] as const,
  teamMembers: (id: string) => ["teams", id, "members"] as const,
  auditEvents: (filters: Record<string, string | undefined>) => ["audit-events", filters] as const,
  authSessions: ["auth", "sessions"] as const,
  authenticators: ["auth", "authenticators"] as const,
  totp: ["auth", "totp"] as const,
  recoveryCodes: ["auth", "recovery-codes"] as const,
};

/**
 * The session query. GET /api/v1/session/ also sets the CSRF cookie, so every
 * page tree mounts this first. Auth errors are not retried.
 */
export function useSession(): UseQueryResult<Session, Error> {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: ({ signal }) => getSession(signal),
    staleTime: 30_000,
    retry: (count, error) => {
      if (isApiError(error) && (error.status === 401 || error.status === 403)) return false;
      return count < 2;
    },
  });
}

export function useInvalidateSession(): () => Promise<void> {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: queryKeys.session });
}

/** Active organisation context; throws if used outside an authenticated tree. */
export function useActive(): ActiveContext | null {
  const { data } = useSession();
  return data?.active ?? null;
}

/** Scope of a permission for the active membership, or null when absent. UI-only gating. */
export function usePermission(key: string): PermissionScope | null {
  const active = useActive();
  return active?.permissions?.[key] ?? null;
}

export function hasPermission(active: ActiveContext | null | undefined, key: string): boolean {
  return Boolean(active?.permissions?.[key]);
}
