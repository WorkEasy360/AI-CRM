"use client";

import { useQuery } from "@tanstack/react-query";
import { listRoles } from "@/lib/api/endpoints";
import { ROLE_KEYS, type RoleDefinition } from "@/lib/api/types";
import { queryKeys } from "@/lib/session";
import { humanize } from "@/lib/utils";

export const FALLBACK_ROLES: RoleDefinition[] = ROLE_KEYS.map((key) => ({
  key,
  name: humanize(key),
  description: "",
  grants: [],
}));

/** Role catalogue from the API, falling back to the well-known keys if it cannot be read. */
export function useRoles(): { roles: RoleDefinition[]; isPending: boolean } {
  const query = useQuery({
    queryKey: queryKeys.roles,
    queryFn: listRoles,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const roles = query.data?.results?.length ? query.data.results : FALLBACK_ROLES;
  return { roles, isPending: query.isPending };
}
