import type { components } from "@/lib/api/schema";

/* Types generated from openapi.json */
export type Membership = components["schemas"]["Membership"];
export type Invitation = components["schemas"]["Invitation"];
export type Team = components["schemas"]["Team"];
export type TeamRequest = components["schemas"]["TeamRequest"];
export type AuditEvent = components["schemas"]["AuditEvent"];
export type UserPublic = components["schemas"]["UserPublic"];
export type RoleRef = components["schemas"]["RoleRef"];
export type MembershipStatus = components["schemas"]["StatusEnum"];
export type PaginatedMembershipList = components["schemas"]["PaginatedMembershipList"];
export type PaginatedInvitationList = components["schemas"]["PaginatedInvitationList"];
export type PaginatedTeamList = components["schemas"]["PaginatedTeamList"];
export type PaginatedAuditEventList = components["schemas"]["PaginatedAuditEventList"];

export interface Paginated<T> {
  next: string | null;
  previous: string | null;
  results: T[];
}

/* Hand-written types for endpoints the schema leaves untyped ("No response body"). */
export const ROLE_KEYS = ["owner", "admin", "sales_manager", "sales_rep", "viewer"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export type PermissionScope = "own" | "team" | "all";
export type Permissions = Record<string, PermissionScope>;

export interface Organization {
  id: string;
  name: string;
  slug: string;
  base_currency: string;
  timezone: string;
  plan: string;
  status: string;
  require_mfa: boolean;
  created_at: string;
}

export interface SessionMembership {
  id: string;
  organization: Organization;
  role: RoleRef;
  status: MembershipStatus;
}

export interface ActiveContext {
  membership_id: string;
  organization: Organization;
  role: RoleRef;
  permissions: Permissions;
  mfa_required: boolean;
}

export interface Session {
  user: UserPublic;
  mfa_enabled: boolean;
  recently_authenticated: boolean;
  memberships: SessionMembership[];
  active: ActiveContext | null;
}

export interface RoleDefinition {
  key: RoleKey | string;
  name: string;
  description: string;
  grants: Record<string, PermissionScope> | string[];
}

export interface CreateOrganizationInput {
  name: string;
  base_currency?: string;
  timezone?: string;
}

export interface CreateOrganizationResponse {
  membership_id: string;
  organization: Organization;
}

export interface UpdateOrganizationInput {
  name?: string;
  base_currency?: string;
  timezone?: string;
  require_mfa?: boolean;
}

export interface TeamMember {
  membership_id?: string;
  id?: string;
  user?: UserPublic;
  role?: RoleRef;
  status?: MembershipStatus;
}

export interface AuditEventFilters {
  action?: string;
  actor_user?: string;
  resource_type?: string;
  since?: string;
  until?: string;
}
