import type { components } from "@/lib/api/schema";

/* Types generated from openapi.json */
export type Membership = components["schemas"]["Membership"];
export type Invitation = components["schemas"]["Invitation"];
export type Team = components["schemas"]["Team"];
export type TeamRequest = components["schemas"]["TeamRequest"];
export type AuditEvent = components["schemas"]["AuditEvent"];
export type UserPublic = components["schemas"]["UserPublic"];
export type RoleRef = components["schemas"]["RoleRef"];
export type MembershipStatus = components["schemas"]["Membership"]["status"];
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

export const DASHBOARD_PERIODS = ["7d", "30d", "90d", "365d"] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];

export interface DashboardMoney {
  count: number;
  amount: string;
}

export interface DashboardStage {
  id: string;
  name: string;
  kind: "open" | "won" | "lost";
  color_token: string;
  count: number;
  amount: string;
}

export interface DashboardActivities {
  /** Completed inside the period. */
  tasks_completed: number;
  meetings_completed: number;
  calls_completed: number;
  /** Open work right now. */
  tasks_due: number;
  tasks_overdue: number;
  meetings_upcoming: number;
  calls_upcoming: number;
}

export interface DashboardLeadConversion {
  created: number;
  converted: number;
  /** Percentage 0-100; null when nothing was created in the period. */
  rate: number | null;
}

export interface DashboardOwnerRow {
  id: string;
  name: string;
  count: number;
  amount: string;
  /** Sum of value x probability for the owner's open deals. */
  weighted: string;
}

export interface DashboardForecastMonth {
  month: string;
  count: number;
  amount: string;
  weighted: string;
}

export interface DashboardSummary {
  period: DashboardPeriod;
  since: string;
  until: string;
  currency: string;
  /** Null when the member lacks the module's view permission. */
  activities: DashboardActivities | null;
  contacts_created: number | null;
  lead_conversion: DashboardLeadConversion | null;
  deals_won: DashboardMoney | null;
  deals_lost: DashboardMoney | null;
  /** Open deals right now. */
  open_pipeline: DashboardMoney | null;
  /** Sum of value x probability over the open deals (server-computed). */
  weighted_pipeline: DashboardMoney | null;
  /** Percentage 0-100 of closed deals that were won; null when nothing closed. */
  win_rate: number | null;
  average_deal_size: string | null;
  deals_by_stage: { pipeline: { id: string; name: string } | null; stages: DashboardStage[] } | null;
  deals_by_owner: DashboardOwnerRow[] | null;
  revenue_trend: { month: string; count: number; amount: string }[] | null;
  /** Next three months by expected close date. */
  forecast: DashboardForecastMonth[] | null;
  top_companies: { id: string; name: string; count: number; amount: string }[] | null;
}

export interface AuditEventFilters {
  action?: string;
  actor_user?: string;
  resource_type?: string;
  since?: string;
  until?: string;
}
