"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { MoreHorizontal, Pencil, Plus, Trash2, Users, UsersRound } from "lucide-react";
import { z } from "zod";
import { PageHeader } from "@/components/page-header";
import { UsersTeamsTabs } from "@/components/settings/users-teams-tabs";
import { isReauthCancelled, useReauth } from "@/components/reauth-provider";
import { Avatar } from "@/components/ui/avatar";
import { Badge, roleBadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  listMembers,
  listTeamMembers,
  listTeams,
  removeTeamMember,
  updateTeam,
} from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/problem";
import type { Membership, Team, TeamMember } from "@/lib/api/types";
import { hasPermission, queryKeys, useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { teamNameSchema } from "@/lib/validation";

const NONE = "__none__";

const teamSchema = z.object({
  name: teamNameSchema,
  manager_id: z.string(),
});
type TeamInput = z.infer<typeof teamSchema>;

function memberLabel(m: Membership): string {
  return m.user.display_name || m.user.email;
}

export function TeamsPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const canManage = hasPermission(active, "teams.manage");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();

  const teams = useCursorList(queryKeys.teams, listTeams);
  const members = useCursorList(queryKeys.members, listMembers);
  const membersById = React.useMemo(() => new Map(members.items.map((m) => [m.id, m])), [members.items]);

  const [editing, setEditing] = React.useState<Team | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<Team | null>(null);
  const [managing, setManaging] = React.useState<Team | null>(null);

  const fail = (title: string) => (err: unknown) => {
    if (isReauthCancelled(err)) return;
    toast({ tone: "error", title, description: errorMessage(err) });
  };

  const deleteMutation = useMutation({
    mutationFn: (id: string) => runSensitive(() => deleteTeam(id)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.teams });
      toast({ tone: "success", title: "Team deleted" });
      setDeleting(null);
    },
    onError: fail("Could not delete team"),
  });

  return (
    <div>
      <PageHeader
        title="Users & Teams"
        description="Group members into teams to scope what they can see and manage."
        actions={
          canManage ? (
            <Button onClick={() => setEditing("new")}>
              <Plus /> New team
            </Button>
          ) : null
        }
      />
      <UsersTeamsTabs />

      {teams.isPending ? (
        <SkeletonRows rows={3} />
      ) : teams.isError ? (
        <EmptyState title="Could not load teams" description={errorMessage(teams.error)} action={<Button variant="secondary" onClick={() => teams.refetch()}>Retry</Button>} />
      ) : teams.items.length === 0 ? (
        <EmptyState
          icon={<UsersRound />}
          title="No teams yet"
          description="Create a team, pick a manager and add members."
          action={canManage ? <Button onClick={() => setEditing("new")}>Create a team</Button> : null}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {teams.items.map((team) => {
            const manager = team.manager_id ? membersById.get(team.manager_id) : undefined;
            return (
              <Card key={team.id}>
                <CardContent className="flex items-start gap-3">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-sm bg-accent-soft text-accent">
                    <UsersRound className="size-5" aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-semibold">{team.name}</h3>
                    <p className="text-xs text-fg-subtle">
                      {team.member_count} {team.member_count === 1 ? "member" : "members"}
                      {manager ? ` · Managed by ${memberLabel(manager)}` : team.manager_id ? " · Manager assigned" : " · No manager"}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <Button variant="secondary" size="sm" onClick={() => setManaging(team)}>
                        <Users /> Members
                      </Button>
                    </div>
                  </div>
                  {canManage ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${team.name}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setEditing(team)}>
                          <Pencil /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem destructive onSelect={() => setDeleting(team)}>
                          <Trash2 /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      {teams.hasMore ? (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" onClick={() => teams.loadMore()} loading={teams.isLoadingMore}>
            Load more
          </Button>
        </div>
      ) : null}

      <TeamDialog team={editing} members={members.items} onOpenChange={(open) => !open && setEditing(null)} />
      <TeamMembersDialog team={managing} members={members.items} canManage={canManage} onOpenChange={(open) => !open && setManaging(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "team"}?`}
        description="Members keep their organization access; only the team grouping is removed."
        confirmLabel="Delete team"
        destructive
        loading={deleteMutation.isPending}
        onConfirm={() => deleting && deleteMutation.mutate(deleting.id)}
      />
    </div>
  );
}

function TeamDialog({ team, members, onOpenChange }: { team: Team | "new" | null; members: Membership[]; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const isNew = team === "new";
  const existing = team && team !== "new" ? team : null;

  const form = useForm<TeamInput>({
    resolver: zodResolver(teamSchema),
    defaultValues: { name: "", manager_id: NONE },
  });

  React.useEffect(() => {
    if (team) {
      form.reset({ name: existing?.name ?? "", manager_id: existing?.manager_id ?? NONE });
      setFieldErrors({});
    }
  }, [team, existing, form]);

  const mutation = useMutation({
    mutationFn: (values: TeamInput) => {
      const payload = { name: values.name, manager_id: values.manager_id === NONE ? null : values.manager_id };
      return runSensitive(() => (existing ? updateTeam(existing.id, payload) : createTeam(payload)));
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.teams });
      toast({ tone: "success", title: isNew ? "Team created" : "Team updated", description: saved.name });
      onOpenChange(false);
    },
    onError: (err) => {
      if (isReauthCancelled(err)) return;
      if (isApiError(err) && err.isValidation) setFieldErrors(err.fieldErrors());
      else toast({ tone: "error", title: "Could not save team", description: errorMessage(err) });
    },
  });

  const activeMembers = members.filter((m) => m.status === "active");

  return (
    <Dialog open={team !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{isNew ? "New team" : "Edit team"}</DialogTitle>
            <DialogDescription>Give the team a name and optionally a manager.</DialogDescription>
          </DialogHeader>
          <FormError message={fieldErrors.non_field_errors} />
          <FormField control={form.control} name="name" label="Team name" serverError={fieldErrors.name}>
            {(field) => <Input {...field} autoFocus placeholder="EMEA Sales" value={field.value} onChange={(e) => field.onChange(e.target.value)} />}
          </FormField>
          <FormField control={form.control} name="manager_id" label="Manager" serverError={fieldErrors.manager_id}>
            {(field) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id={field.id} aria-invalid={field["aria-invalid"]} aria-describedby={field["aria-describedby"]}>
                  <SelectValue placeholder="No manager" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No manager</SelectItem>
                  {activeMembers.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {memberLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {isNew ? "Create team" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function teamMemberId(tm: TeamMember): string {
  return tm.membership_id ?? tm.id ?? "";
}

function TeamMembersDialog({
  team,
  members,
  canManage,
  onOpenChange,
}: {
  team: Team | null;
  members: Membership[];
  canManage: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  const [selected, setSelected] = React.useState("");
  const teamId = team?.id ?? "";

  const teamMembers = useQuery({
    queryKey: queryKeys.teamMembers(teamId),
    queryFn: () => listTeamMembers(teamId),
    enabled: Boolean(teamId),
  });

  const invalidate = () =>
    Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.teamMembers(teamId) }), queryClient.invalidateQueries({ queryKey: queryKeys.teams })]);

  const fail = (title: string) => (err: unknown) => {
    if (isReauthCancelled(err)) return;
    toast({ tone: "error", title, description: errorMessage(err) });
  };

  const addMutation = useMutation({
    mutationFn: (membershipId: string) => runSensitive(() => addTeamMember(teamId, membershipId)),
    onSuccess: async () => {
      await invalidate();
      setSelected("");
    },
    onError: fail("Could not add member"),
  });

  const removeMutation = useMutation({
    mutationFn: (membershipId: string) => runSensitive(() => removeTeamMember(teamId, membershipId)),
    onSuccess: invalidate,
    onError: fail("Could not remove member"),
  });

  const membersById = React.useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const currentIds = new Set((teamMembers.data ?? []).map(teamMemberId));
  const addable = members.filter((m) => m.status === "active" && !currentIds.has(m.id));

  return (
    <Dialog open={team !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{team?.name ?? "Team"} members</DialogTitle>
          <DialogDescription>{canManage ? "Add or remove people from this team." : "People in this team."}</DialogDescription>
        </DialogHeader>

        {canManage ? (
          <div className="grid gap-1.5">
            <Label htmlFor="add-team-member">Add a member</Label>
            <div className="flex gap-2">
              <Select value={selected} onValueChange={setSelected}>
                <SelectTrigger id="add-team-member" className="flex-1">
                  <SelectValue placeholder={addable.length ? "Choose a member" : "Everyone is already in this team"} />
                </SelectTrigger>
                <SelectContent>
                  {addable.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {memberLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={() => selected && addMutation.mutate(selected)} disabled={!selected} loading={addMutation.isPending}>
                Add
              </Button>
            </div>
          </div>
        ) : null}

        <div className="max-h-80 overflow-y-auto rounded-sm border border-border">
          {teamMembers.isPending ? (
            <div className="p-3">
              <SkeletonRows rows={3} />
            </div>
          ) : teamMembers.isError ? (
            <p className="p-3 text-sm text-danger">{errorMessage(teamMembers.error)}</p>
          ) : teamMembers.data.length === 0 ? (
            <p className="p-4 text-center text-sm text-fg-muted">No members in this team yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {teamMembers.data.map((tm) => {
                const id = teamMemberId(tm);
                const membership = membersById.get(id);
                const user = tm.user ?? membership?.user;
                const role = tm.role ?? membership?.role;
                const label = user?.display_name || user?.email || id;
                return (
                  <li key={id} className="flex items-center gap-3 px-3 py-2">
                    <Avatar name={label} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{label}</div>
                      {user?.email && user.email !== label ? <div className="truncate text-xs text-fg-subtle">{user.email}</div> : null}
                    </div>
                    {role ? <Badge variant={roleBadgeVariant(role.key)}>{role.name}</Badge> : null}
                    {canManage ? (
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        onClick={() => removeMutation.mutate(id)}
                        loading={removeMutation.isPending && removeMutation.variables === id}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
