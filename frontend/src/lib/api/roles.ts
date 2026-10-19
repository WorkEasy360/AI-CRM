import { api } from "@/lib/api/client";

export type Scope = "own" | "subordinates" | "team" | "all";
export type FieldAccess = "hidden" | "read_only";
/** Modules with field rules; "deal_line" is a deal's product lines. */
export type FieldEntity = "contact" | "company" | "deal" | "product" | "deal_line";

export interface PermissionSet {
  key: string;
  name: string;
  description: string;
  is_system: boolean;
  grants: Record<string, Scope>;
  member_count: number;
}

export interface PermissionSetList {
  results: PermissionSet[];
  permissions: string[];
  scopes: Scope[];
}

export interface FieldRule {
  field: string;
  access: FieldAccess;
}

export interface HierarchyRole {
  id: string;
  name: string;
  description: string;
  parent_id: string | null;
  share_with_peers: boolean;
  member_count: number;
  created_at: string;
}

export const rolesKeys = {
  sets: ["roles", "sets"] as const,
  fields: (key: string) => ["roles", "fields", key] as const,
  hierarchy: ["roles", "hierarchy"] as const,
};

const enc = encodeURIComponent;

export const listPermissionSets = () => api.get<PermissionSetList>("/api/v1/roles/");
export const createPermissionSet = (input: { name: string; description?: string; clone_from?: string; grants?: Record<string, Scope> }) =>
  api.post<PermissionSet>("/api/v1/roles/", input);
export const updatePermissionSet = (key: string, input: { name?: string; description?: string; grants?: Record<string, Scope> }) =>
  api.patch<PermissionSet>(`/api/v1/roles/${enc(key)}/`, input);
export const deletePermissionSet = (key: string) => api.delete(`/api/v1/roles/${enc(key)}/`);

export const getFieldRules = (key: string) =>
  api.get<{ role: string; rules: Record<FieldEntity, FieldRule[]> }>(`/api/v1/roles/${enc(key)}/field-permissions/`);
export const setFieldRules = (key: string, entity_type: FieldEntity, rules: FieldRule[]) =>
  api.put<{ entity_type: FieldEntity; rules: FieldRule[] }>(`/api/v1/roles/${enc(key)}/field-permissions/`, { entity_type, rules });

export const listHierarchyRoles = () =>
  api.get<{ results: HierarchyRole[] }>("/api/v1/hierarchy-roles/").then((data) => data.results);
export const createHierarchyRole = (input: { name: string; parent_id?: string | null; share_with_peers?: boolean }) =>
  api.post<HierarchyRole>("/api/v1/hierarchy-roles/", input);
export const updateHierarchyRole = (id: string, input: Partial<Pick<HierarchyRole, "name" | "parent_id" | "share_with_peers">>) =>
  api.patch<HierarchyRole>(`/api/v1/hierarchy-roles/${enc(id)}/`, input);
export const deleteHierarchyRole = (id: string) => api.delete(`/api/v1/hierarchy-roles/${enc(id)}/`);
export const assignHierarchyRole = (membership_id: string, hierarchy_role_id: string | null) =>
  api.post<{ membership_id: string; hierarchy_role_id: string | null }>("/api/v1/hierarchy-roles/assign/", {
    membership_id,
    hierarchy_role_id,
  });
