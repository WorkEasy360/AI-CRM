"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CornerDownRight, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { listMembers } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/problem";
import {
  assignHierarchyRole,
  createHierarchyRole,
  createPermissionSet,
  deleteHierarchyRole,
  deletePermissionSet,
  getFieldRules,
  listHierarchyRoles,
  listPermissionSets,
  rolesKeys,
  setFieldRules,
  updateHierarchyRole,
  updatePermissionSet,
  type FieldAccess,
  type FieldEntity,
  type HierarchyRole,
  type PermissionSet,
  type Scope,
} from "@/lib/api/roles";
import { useModuleSchema } from "@/lib/views";
import { queryKeys } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";

const NONE = "__none__";
const SCOPE_LABEL: Record<Scope, string> = {
  own: "Own records",
  subordinates: "Own + subordinates",
  team: "Own team",
  all: "All records",
};
const MODULE_LABEL: Record<string, string> = {
  org: "Organization",
  members: "Users",
  teams: "Teams",
  roles: "Roles",
  audit: "Audit log",
  settings: "Settings",
  contacts: "Contacts",
  companies: "Companies",
  products: "Products",
  deals: "Pipelines (deals)",
  pipelines: "Pipeline setup",
  customfields: "Custom fields",
  tags: "Tags",
  notes: "Notes",
  activities: "Activities",
  files: "Files",
  notifications: "Signals",
  dashboards: "Dashboards",
  reports: "Reports",
  search: "Search",
  ai: "AI",
  email: "Email",
  whatsapp: "WhatsApp",
  integrations: "Integrations",
  webhooks: "Webhooks",
  privacy: "Privacy",
};
// Identity and bookkeeping fields the server never lets a permission set restrict.
const PROTECTED_FIELDS = new Set(["id", "name", "display_name", "owner", "tags", "version", "created_at", "updated_at", "archived_at"]);
// Product lines are not a module of their own, so their fields are listed here.
const DEAL_LINE_FIELDS = [
  { key: "quantity", label: "Quantity" },
  { key: "unit_price", label: "Unit price" },
  { key: "discount_percent", label: "Discount" },
  { key: "tax_rate", label: "Tax rate" },
];
const ENTITY_LABEL: Record<FieldEntity, string> = {
  contact: "Contacts",
  company: "Companies",
  deal: "Deals",
  deal_line: "Deal product lines",
  product: "Products",
};

function humanize(field: string): string {
  return field.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function RolesPage() {
  return (
    <div>
      <PageHeader
        title="Roles & permissions"
        description="Profiles decide what people can do; the role hierarchy decides whose records they see."
      />
      <Tabs defaultValue="profiles">
        <TabsList>
          <TabsTrigger value="profiles">Profiles</TabsTrigger>
          <TabsTrigger value="hierarchy">Role hierarchy</TabsTrigger>
          <TabsTrigger value="fields">Field permissions</TabsTrigger>
        </TabsList>
        <TabsContent value="profiles">
          <ProfilesTab />
        </TabsContent>
        <TabsContent value="hierarchy">
          <HierarchyTab />
        </TabsContent>
        <TabsContent value="fields">
          <FieldsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ profiles */

function ProfilesTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const sets = useQuery({ queryKey: rolesKeys.sets, queryFn: listPermissionSets });
  const [selected, setSelected] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: rolesKeys.sets }),
      queryClient.invalidateQueries({ queryKey: queryKeys.roles }),
    ]);

  const remove = useMutation({
    mutationFn: deletePermissionSet,
    onSuccess: async () => {
      setSelected(null);
      await refresh();
      toast({ tone: "success", title: "Profile deleted" });
    },
    onError: (err) => toast({ tone: "error", title: "Could not delete", description: errorMessage(err) }),
  });

  if (sets.isLoading) return <SkeletonRows rows={5} />;
  const list = sets.data?.results ?? [];
  const current = list.find((r) => r.key === selected) ?? null;

  return (
    <div className="grid gap-3 lg:grid-cols-[18rem_1fr]">
      <Card>
        <CardContent className="space-y-1 p-2">
          {list.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setSelected(r.key)}
              aria-current={selected === r.key ? "true" : undefined}
              className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm ${
                selected === r.key ? "bg-primary-soft text-primary" : "hover:bg-bg-subtle"
              }`}
            >
              <span className="truncate">{r.name}</span>
              <span className="flex items-center gap-1.5">
                {r.is_system ? <Badge variant="neutral">System</Badge> : null}
                <span className="text-xs text-fg-muted">{r.member_count}</span>
              </span>
            </button>
          ))}
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => setCreating(true)}>
            <Plus aria-hidden /> New profile
          </Button>
        </CardContent>
      </Card>
      {current ? (
        <GrantEditor
          key={current.key}
          set={current}
          permissions={sets.data?.permissions ?? []}
          scopes={sets.data?.scopes ?? []}
          onSaved={refresh}
          onDelete={() => remove.mutate(current.key)}
        />
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center text-sm text-fg-muted">
            <ShieldCheck className="size-6" aria-hidden />
            Pick a profile to see what it allows, or create one from an existing profile.
          </CardContent>
        </Card>
      )}
      <CreateProfileDialog
        open={creating}
        sets={list}
        onClose={() => setCreating(false)}
        onCreated={async (key) => {
          setCreating(false);
          await refresh();
          setSelected(key);
        }}
      />
    </div>
  );
}

function CreateProfileDialog({
  open,
  sets,
  onClose,
  onCreated,
}: {
  open: boolean;
  sets: PermissionSet[];
  onClose: () => void;
  onCreated: (key: string) => void;
}) {
  const { toast } = useToast();
  const [name, setName] = React.useState("");
  const [cloneFrom, setCloneFrom] = React.useState("sales_rep");
  const create = useMutation({
    mutationFn: () => createPermissionSet({ name, clone_from: cloneFrom }),
    onSuccess: (set) => {
      setName("");
      onCreated(set.key);
    },
    onError: (err) => toast({ tone: "error", title: "Could not create profile", description: errorMessage(err) }),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New profile</DialogTitle>
          <DialogDescription>Start from an existing profile, then adjust what it allows.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="profile-name">Name</Label>
            <Input id="profile-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </div>
          <div className="space-y-1">
            <Label>Copy permissions from</Label>
            <Select value={cloneFrom} onValueChange={setCloneFrom}>
              <SelectTrigger aria-label="Copy permissions from">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sets
                  .filter((s) => s.key !== "owner")
                  .map((s) => (
                    <SelectItem key={s.key} value={s.key}>
                      {s.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GrantEditor({
  set,
  permissions,
  scopes,
  onSaved,
  onDelete,
}: {
  set: PermissionSet;
  permissions: string[];
  scopes: Scope[];
  onSaved: () => Promise<unknown>;
  onDelete: () => void;
}) {
  const { toast } = useToast();
  const [grants, setGrants] = React.useState<Record<string, Scope>>(set.grants);
  const dirty = JSON.stringify(grants) !== JSON.stringify(set.grants);
  const save = useMutation({
    mutationFn: () => updatePermissionSet(set.key, { grants }),
    onSuccess: async () => {
      await onSaved();
      toast({ tone: "success", title: "Profile saved" });
    },
    onError: (err) => toast({ tone: "error", title: "Could not save", description: errorMessage(err) }),
  });
  const groups = React.useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of permissions) {
      const prefix = p.split(".")[0] ?? p;
      map.set(prefix, [...(map.get(prefix) ?? []), p]);
    }
    return [...map.entries()];
  }, [permissions]);
  const readOnly = set.is_system;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>{set.name}</CardTitle>
          <CardDescription>
            {readOnly ? "System profiles can't be changed. Create a profile from this one to customise it." : set.description || "Custom profile"}
          </CardDescription>
        </div>
        {!readOnly ? (
          <div className="flex gap-2">
            <Button variant="danger-ghost" size="sm" onClick={onDelete} disabled={set.member_count > 0} title={set.member_count ? "Move members off this profile first" : undefined}>
              <Trash2 aria-hidden /> Delete
            </Button>
            <Button size="sm" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
              Save
            </Button>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {groups.map(([prefix, perms]) => (
          <fieldset key={prefix} className="space-y-1">
            <legend className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{MODULE_LABEL[prefix] ?? humanize(prefix)}</legend>
            {perms.map((p) => (
              <div key={p} className="flex items-center justify-between gap-2 py-0.5">
                <span className="text-sm text-fg">{humanize(p.split(".").slice(1).join(" "))}</span>
                <Select
                  disabled={readOnly}
                  value={grants[p] ?? NONE}
                  onValueChange={(v) =>
                    setGrants((g) => {
                      const next = { ...g };
                      if (v === NONE) delete next[p];
                      else next[p] = v as Scope;
                      return next;
                    })
                  }
                >
                  <SelectTrigger className="h-8 w-48" aria-label={`${p} access`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No access</SelectItem>
                    {scopes.map((s) => (
                      <SelectItem key={s} value={s}>
                        {SCOPE_LABEL[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </fieldset>
        ))}
      </CardContent>
    </Card>
  );
}

/* ----------------------------------------------------------------------------------------- hierarchy */

function HierarchyTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const roles = useQuery({ queryKey: rolesKeys.hierarchy, queryFn: listHierarchyRoles });
  const members = useCursorList(queryKeys.members, listMembers);
  const [newName, setNewName] = React.useState("");
  const [newParent, setNewParent] = React.useState(NONE);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: rolesKeys.hierarchy }),
      queryClient.invalidateQueries({ queryKey: queryKeys.members }),
    ]);
  const fail = (title: string) => (err: unknown) => toast({ tone: "error", title, description: errorMessage(err) });

  const create = useMutation({
    mutationFn: () => createHierarchyRole({ name: newName, parent_id: newParent === NONE ? null : newParent }),
    onSuccess: async () => {
      setNewName("");
      await refresh();
    },
    onError: fail("Could not add role"),
  });
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof updateHierarchyRole>[1] }) => updateHierarchyRole(id, input),
    onSuccess: refresh,
    onError: fail("Could not update role"),
  });
  const remove = useMutation({ mutationFn: deleteHierarchyRole, onSuccess: refresh, onError: fail("Could not delete role") });
  const assign = useMutation({
    mutationFn: ({ membership, role }: { membership: string; role: string | null }) => assignHierarchyRole(membership, role),
    onSuccess: refresh,
    onError: fail("Could not assign role"),
  });

  if (roles.isLoading) return <SkeletonRows rows={5} />;
  const list = roles.data ?? [];
  const ordered = treeOrder(list);

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Hierarchy</CardTitle>
          <CardDescription>
            People see records owned by anyone below them when a profile grants &ldquo;Own + subordinates&rdquo;.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {ordered.length === 0 ? <p className="text-sm text-fg-muted">No roles yet. Add the top of your organization first.</p> : null}
          {ordered.map(({ role, depth }) => (
            <div key={role.id} className="flex items-center justify-between gap-2 rounded-sm border border-border px-2 py-1.5" style={{ marginLeft: depth * 16 }}>
              <span className="flex min-w-0 items-center gap-1.5 text-sm text-fg">
                {depth ? <CornerDownRight className="size-3.5 text-fg-subtle" aria-hidden /> : null}
                <span className="truncate">{role.name}</span>
                <span className="text-xs text-fg-muted">({role.member_count})</span>
              </span>
              <span className="flex items-center gap-2">
                <label className="flex items-center gap-1 text-xs text-fg-muted">
                  <Switch
                    checked={role.share_with_peers}
                    onCheckedChange={(v) => update.mutate({ id: role.id, input: { share_with_peers: v } })}
                    aria-label={`${role.name}: share data with peers`}
                  />
                  Peers
                </label>
                <Button variant="ghost" size="icon-sm" aria-label={`Delete ${role.name}`} onClick={() => remove.mutate(role.id)}>
                  <Trash2 aria-hidden />
                </Button>
              </span>
            </div>
          ))}
          <div className="flex flex-wrap items-end gap-2 pt-2">
            <div className="min-w-40 flex-1 space-y-1">
              <Label htmlFor="new-hierarchy-role">New role</Label>
              <Input id="new-hierarchy-role" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Regional manager" />
            </div>
            <Select value={newParent} onValueChange={setNewParent}>
              <SelectTrigger className="w-44" aria-label="Reports to">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Top of hierarchy</SelectItem>
                {list.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    Reports to {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button disabled={!newName.trim()} loading={create.isPending} onClick={() => create.mutate()}>
              <Plus aria-hidden /> Add
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>People</CardTitle>
          <CardDescription>Place each person in the hierarchy.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {members.items.map((m) => {
            const current = m.hierarchy_role_id ?? NONE;
            return (
              <div key={m.id} className="flex items-center justify-between gap-2 py-0.5">
                <span className="truncate text-sm text-fg">{m.user.display_name || m.user.email}</span>
                <Select value={current} onValueChange={(v) => assign.mutate({ membership: m.id, role: v === NONE ? null : v })}>
                  <SelectTrigger className="h-8 w-48" aria-label={`Role of ${m.user.display_name || m.user.email}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Not placed</SelectItem>
                    {list.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

function treeOrder(roles: HierarchyRole[]): { role: HierarchyRole; depth: number }[] {
  const children = new Map<string | null, HierarchyRole[]>();
  for (const r of roles) children.set(r.parent_id, [...(children.get(r.parent_id) ?? []), r]);
  const out: { role: HierarchyRole; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const r of children.get(parent) ?? []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ role: r, depth });
      walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/* ------------------------------------------------------------------------------------ field permissions */

function FieldsTab() {
  const sets = useQuery({ queryKey: rolesKeys.sets, queryFn: listPermissionSets });
  const editable = (sets.data?.results ?? []).filter((s) => s.key !== "owner");
  const [setKey, setSetKey] = React.useState<string>("");
  const [entity, setEntity] = React.useState<FieldEntity>("contact");
  const key = setKey || editable[0]?.key || "";

  if (sets.isLoading) return <SkeletonRows rows={5} />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Field permissions</CardTitle>
        <CardDescription>Hide a field from a profile, or let it see but not change it. The Owner always has full access.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Select value={key} onValueChange={setSetKey}>
            <SelectTrigger className="w-56" aria-label="Profile">
              <SelectValue placeholder="Profile" />
            </SelectTrigger>
            <SelectContent>
              {editable.map((s) => (
                <SelectItem key={s.key} value={s.key}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={entity} onValueChange={(v) => setEntity(v as FieldEntity)}>
            <SelectTrigger className="w-40" aria-label="Module">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(ENTITY_LABEL) as FieldEntity[]).map((e) => (
                <SelectItem key={e} value={e}>
                  {ENTITY_LABEL[e]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {key ? <FieldRuleEditor key={`${key}:${entity}`} setKey={key} entity={entity} /> : null}
      </CardContent>
    </Card>
  );
}

function FieldRuleEditor({ setKey, entity }: { setKey: string; entity: FieldEntity }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const rules = useQuery({ queryKey: rolesKeys.fields(setKey), queryFn: () => getFieldRules(setKey) });
  // The module schema lists every field, custom ones included (the Owner set sees them all).
  const schema = useModuleSchema(entity === "deal_line" ? "deal" : entity);
  const [draft, setDraft] = React.useState<Record<string, FieldAccess> | null>(null);
  const saved = React.useMemo(
    () => Object.fromEntries((rules.data?.rules[entity] ?? []).map((r) => [r.field, r.access])) as Record<string, FieldAccess>,
    [rules.data, entity],
  );
  const values = draft ?? saved;
  const save = useMutation({
    mutationFn: () => setFieldRules(setKey, entity, Object.entries(values).map(([field, access]) => ({ field, access }))),
    onSuccess: async () => {
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: rolesKeys.fields(setKey) });
      toast({ tone: "success", title: "Field permissions saved" });
    },
    onError: (err) => toast({ tone: "error", title: "Could not save", description: errorMessage(err) }),
  });
  if (rules.isLoading) return <SkeletonRows rows={4} />;
  const fields: { key: string; label: string }[] =
    entity === "deal_line"
      ? DEAL_LINE_FIELDS
      : (schema.data?.fields ?? [])
          // Computed fields (amount in base currency, weighted amount) follow the field they derive from.
          .filter((f) => !PROTECTED_FIELDS.has(f.key) && (f.editable || f.read_only || f.custom))
          .map((f) => ({ key: f.key, label: f.custom ? `${f.label} (custom)` : f.label }));
  return (
    <div className="space-y-1">
      {fields.map((f) => (
        <div key={f.key} className="flex items-center justify-between gap-2 border-b border-border py-1 last:border-0">
          <span className="text-sm text-fg">{f.label}</span>
          <Select
            value={values[f.key] ?? NONE}
            onValueChange={(v) =>
              setDraft(() => {
                const next = { ...values };
                if (v === NONE) delete next[f.key];
                else next[f.key] = v as FieldAccess;
                return next;
              })
            }
          >
            <SelectTrigger className="h-8 w-40" aria-label={`${f.label} access`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Read & write</SelectItem>
              <SelectItem value="read_only">Read only</SelectItem>
              <SelectItem value="hidden">Hidden</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ))}
      <div className="flex justify-end pt-2">
        <Button disabled={draft === null} loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </div>
    </div>
  );
}
