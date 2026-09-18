import { api } from "@/lib/api/client";
import type {
  AuditEvent,
  AuditEventFilters,
  CreateInvitationInput,
  CreateOrganizationInput,
  CreateOrganizationResponse,
  DashboardPeriod,
  DashboardSummary,
  Invitation,
  InvitationAcceptResponse,
  InvitationPreview,
  Membership,
  Organization,
  Paginated,
  RoleDefinition,
  Session,
  Team,
  TeamMember,
  TeamRequest,
  UpdateOrganizationInput,
} from "@/lib/api/types";

/* Session / organisations */
export const getSession = (signal?: AbortSignal) => api.get<Session>("/api/v1/session/", undefined, signal);

export const switchOrganization = (membership_id: string) =>
  api.post<unknown>("/api/v1/session/switch-organization/", { membership_id });

/**
 * Give the session an active organization. The server creates the user's personal workspace when
 * they have none and activates their default membership; the request carries no body on purpose.
 */
export const bootstrapSession = () => api.post<Session>("/api/v1/session/bootstrap/");

export const getDashboard = (period: DashboardPeriod, pipeline?: string) =>
  api.get<DashboardSummary>("/api/v1/dashboard/", { period, pipeline });

export const createOrganization = (input: CreateOrganizationInput) =>
  api.post<CreateOrganizationResponse>("/api/v1/organizations/", input);

export const getCurrentOrganization = () => api.get<Organization>("/api/v1/organizations/current/");

export const updateCurrentOrganization = (input: UpdateOrganizationInput) =>
  api.patch<Organization>("/api/v1/organizations/current/", input);

export const listRoles = () => api.get<{ results: RoleDefinition[] }>("/api/v1/roles/");

/* Members */
export const listMembers = (cursor?: string | null) =>
  api.get<Paginated<Membership>>("/api/v1/members/", { cursor: cursor ?? undefined });

export const updateMemberRole = (id: string, role: string) =>
  api.patch<Membership>(`/api/v1/members/${encodeURIComponent(id)}/role/`, { role });

export const suspendMember = (id: string) => api.post<Membership>(`/api/v1/members/${encodeURIComponent(id)}/suspend/`);

export const reactivateMember = (id: string) =>
  api.post<Membership>(`/api/v1/members/${encodeURIComponent(id)}/reactivate/`);

/** Removes the person from the organization (status "disabled"); only a new invitation brings them back. */
export const removeMember = (id: string) => api.post<Membership>(`/api/v1/members/${encodeURIComponent(id)}/remove/`);

export const revokeMemberSessions = (id: string) =>
  api.post<{ sessions_revoked: number }>(`/api/v1/members/${encodeURIComponent(id)}/revoke-sessions/`);

export const setMemberTeams = (id: string, teamIds: string[]) =>
  api.put<Membership>(`/api/v1/members/${encodeURIComponent(id)}/teams/`, { team_ids: teamIds });

/* Invitations */
export const listInvitations = (cursor?: string | null) =>
  api.get<Paginated<Invitation>>("/api/v1/invitations/", { cursor: cursor ?? undefined });

export const createInvitation = (input: CreateInvitationInput) => api.post<Invitation>("/api/v1/invitations/", input);

export const resendInvitation = (id: string) =>
  api.post<Invitation>(`/api/v1/invitations/${encodeURIComponent(id)}/resend/`);

export const revokeInvitation = (id: string) => api.delete(`/api/v1/invitations/${encodeURIComponent(id)}/`);

export const previewInvitation = (token: string) =>
  api.get<InvitationPreview>("/api/v1/invitations/preview/", { token });

export const acceptInvitation = (token: string) =>
  api.post<InvitationAcceptResponse>("/api/v1/invitations/accept/", { token });

/** New users only: creates the account from the invitation link and signs the browser in. */
export const registerWithInvitation = (input: { token: string; name: string; password: string }) =>
  api.post<InvitationAcceptResponse>("/api/v1/invitations/register/", input);

/* Teams */
export const listTeams = (cursor?: string | null) =>
  api.get<Paginated<Team>>("/api/v1/teams/", { cursor: cursor ?? undefined });

export const createTeam = (input: TeamRequest) => api.post<Team>("/api/v1/teams/", input);

export const updateTeam = (id: string, input: Partial<TeamRequest>) =>
  api.patch<Team>(`/api/v1/teams/${encodeURIComponent(id)}/`, input);

export const deleteTeam = (id: string) => api.delete(`/api/v1/teams/${encodeURIComponent(id)}/`);

/** The schema types this as Team, but the payload is the member list; accept both shapes. */
export const listTeamMembers = async (id: string): Promise<TeamMember[]> => {
  const data = await api.get<unknown>(`/api/v1/teams/${encodeURIComponent(id)}/members/`);
  if (Array.isArray(data)) return data as TeamMember[];
  if (data && typeof data === "object") {
    const obj = data as { results?: TeamMember[]; members?: TeamMember[] };
    return obj.results ?? obj.members ?? [];
  }
  return [];
};

export const addTeamMember = (id: string, membership_id: string) =>
  api.post<unknown>(`/api/v1/teams/${encodeURIComponent(id)}/members/add/`, { membership_id });

export const removeTeamMember = (id: string, membership_id: string) =>
  api.post<unknown>(`/api/v1/teams/${encodeURIComponent(id)}/members/remove/`, { membership_id });

/* Audit log */
export const listAuditEvents = (filters: AuditEventFilters, cursor?: string | null) =>
  api.get<Paginated<AuditEvent>>("/api/v1/audit-events/", { ...filters, cursor: cursor ?? undefined });
