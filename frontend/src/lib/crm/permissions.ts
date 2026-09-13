import type { ActiveContext } from "@/lib/api/types";
import { hasPermission } from "@/lib/session";

type Module = "contacts" | "companies" | "deals" | "products";

/** UI-only gating helpers mirroring the backend rules; the API remains the enforcement point. */
export function can(active: ActiveContext | null | undefined, permission: string): boolean {
  return hasPermission(active, permission);
}

export function scopeOf(active: ActiveContext | null | undefined, permission: string): "own" | "team" | "all" | null {
  return active?.permissions?.[permission] ?? null;
}

/** Whether the actor may hand records of `module` to other members (mirrors records.can_reassign). */
export function canReassign(active: ActiveContext | null | undefined, module: Module): boolean {
  if (module === "deals") return can(active, "deals.reassign");
  return scopeOf(active, `${module}.update`) === "all";
}

/** Whether the actor may edit a specific record given its owner id. */
export function canEditRecord(active: ActiveContext | null | undefined, module: Module, ownerId: string | null | undefined): boolean {
  const scope = scopeOf(active, `${module}.update`);
  if (!scope) return false;
  if (scope === "all") return true;
  if (scope === "own") return Boolean(ownerId) && ownerId === active?.membership_id;
  // team scope: the API decides; show the control optimistically for visible records
  return true;
}

export function canEditNote(active: ActiveContext | null | undefined, authorId: string | null | undefined): boolean {
  const scope = scopeOf(active, "notes.update");
  if (!scope) return false;
  if (scope === "all") return true;
  return Boolean(authorId) && authorId === active?.membership_id;
}

export function canDeleteNote(active: ActiveContext | null | undefined, authorId: string | null | undefined): boolean {
  const scope = scopeOf(active, "notes.delete");
  if (!scope) return false;
  if (scope === "all") return true;
  return Boolean(authorId) && authorId === active?.membership_id;
}
