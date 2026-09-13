import { api } from "@/lib/api/client";
import type {
  AuditEvent,
  AuditEventFilters,
  CreateOrganizationInput,
  CreateOrganizationResponse,
  Invitation,
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

export const disableMember = (id: string) => api.post<Membership>(`/api/v1/members/${encodeURIComponent(id)}/disable/`);

export const enableMember = (id: string) => api.post<Membership>(`/api/v1/members/${encodeURIComponent(id)}/enable/`);

/* Invitations */
export const listInvitations = (cursor?: string | null) =>
  api.get<Paginated<Invitation>>("/api/v1/invitations/", { cursor: cursor ?? undefined });

export const createInvitation = (input: { email: string; role: string }) =>
  api.post<Invitation>("/api/v1/invitations/", input);

export const revokeInvitation = (id: string) => api.delete(`/api/v1/invitations/${encodeURIComponent(id)}/`);

export const previewInvitation = (token: string) =>
  api.get<Invitation & { organization?: { name: string } }>("/api/v1/invitations/preview/", { token });

export const acceptInvitation = (token: string) => api.post<Invitation>("/api/v1/invitations/accept/", { token });

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
