import type { components } from "@/lib/api/schema";

/* Types generated from openapi.json */
export type Membership = components["schemas"]["Membership"];
export type Invitation = components["schemas"]["Invitation"];
export type Team = components["schemas"]["Team"];
export type TeamRequest = components["schemas"]["TeamRequest"];
export type AuditEvent = components["schemas"]["AuditEvent"];
export type UserPublic = components["schemas"]["UserPublic"];
export type RoleRef = components["schemas"]["RoleRef"];
export type TeamRef = components["schemas"]["TeamRef"];
export type MemberDisplayStatus = components["schemas"]["Membership"]["display_status"];
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
  /** Product name for this workspace's sidebar; empty means "WorkEasy CRM". */
  crm_name?: string;
  date_format?: string;
  /** Same-origin URL of the workspace logo, or null. */
  logo_url?: string | null;
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
  /** "workeasy360" when Workeasy360 signed this session in: MFA and re-authentication happen there. */
  identity_provider?: "workeasy360" | null;
  memberships: SessionMembership[];
  active: ActiveContext | null;
}

export interface RoleDefinition {
  key: RoleKey | string;
  name: string;
  description: string;
  grants: Record<string, PermissionScope> | string[];
}

export interface CreateInvitationInput {
  email: string;
  role: string;
  name?: string;
  team_id?: string | null;
}

/** GET /api/v1/invitations/preview/ (public; everything comes from the invitation row). */
export interface InvitationPreview {
  organization_name: string;
  email: string;
  name: string;
  role: string;
  role_name: string;
  invited_by: string;
  expires_at: string;
}

export interface InvitationAcceptResponse {
  membership_id: string;
  organization: Organization;
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
  crm_name?: string;
  date_format?: string;
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
  /** Every open activity past its time, and those due in the next 7 days or today. */
  overdue?: number;
  due_week?: number;
  due_today?: number;
  /** Activities logged in the period, and in the period before it. */
  logged?: number;
  logged_tasks?: number;
  logged_calls?: number;
  logged_meetings?: number;
  prev_logged?: number;
  prev_logged_tasks?: number;
  prev_logged_calls?: number;
  prev_logged_meetings?: number;
}

/** A count at the end of the period and when it started (for growth). */
export interface DashboardGrowth {
  count: number;
  previous: number;
}

/** A computed observation for the AI Insights card; the client words it. */
export type DashboardInsight =
  | { key: "follow_ups_today"; count: number }
  | { key: "deals_close_to_winning"; count: number; amount: string }
  | { key: "win_rate_change"; points: number; current: number }
  | { key: "deals_without_next_step"; count: number }
  | { key: "tickets_overdue"; count: number };

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
  /** A preset ("30d") or a month ("2026-11"). */
  period: string;
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
  /** Deals created in the period. */
  deals_created?: number | null;
  /** The same-length period just before ``since``, for "vs previous" changes. */
  previous?: { since: string; deals_created: number; deals_won: DashboardMoney; win_rate: number | null } | null;
  totals?: { contacts: DashboardGrowth | null; companies: DashboardGrowth | null; deals: DashboardGrowth | null };
  tickets?: { open: number; overdue: number; created: number; created_previous: number } | null;
  /** Deals created in the period by lead source ("" = not recorded). */
  deals_by_source?: { source: string; count: number }[] | null;
  /** Deals won in the period per owner, highest revenue first. */
  top_team?: { id: string; name: string; count: number; amount: string }[] | null;
  deals_closing_week?: number | null;
  insights?: DashboardInsight[];
}

export interface AuditEventFilters {
  action?: string;
  actor_user?: string;
  resource_type?: string;
  since?: string;
  until?: string;
}
