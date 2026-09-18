"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LogOut, MailPlus, MoreHorizontal, RefreshCw, ShieldCheck, UserCheck, UserMinus, UserPlus, UserX, Users, UsersRound, X } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { isReauthCancelled, useReauth } from "@/components/reauth-provider";
import { AssignTeamsDialog } from "@/components/settings/assign-teams-dialog";
import { ChangeRoleDialog } from "@/components/settings/change-role-dialog";
import { InviteMemberDialog } from "@/components/settings/invite-member-dialog";
import { UsersTeamsTabs } from "@/components/settings/users-teams-tabs";
import { Avatar } from "@/components/ui/avatar";
import { Badge, type BadgeProps, roleBadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import {
  listInvitations,
  listMembers,
  listTeams,
  reactivateMember,
  removeMember,
  resendInvitation,
  revokeInvitation,
  revokeMemberSessions,
  setMemberTeams,
  suspendMember,
  updateMemberRole,
} from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/problem";
import type { Invitation, MemberDisplayStatus, Membership } from "@/lib/api/types";
import { useRoles } from "@/lib/roles";
import { hasPermission, queryKeys, useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { formatDate, formatDateTime } from "@/lib/utils";

type RowStatus = MemberDisplayStatus | "invited";

const STATUS: Record<RowStatus, { label: string; variant: BadgeProps["variant"] }> = {
  invited: { label: "Invited", variant: "warning" },
  active: { label: "Active", variant: "success" },
  suspended: { label: "Suspended", variant: "warning" },
  disabled: { label: "Disabled", variant: "danger" },
};

type Confirm =
  | { kind: "suspend" | "reactivate" | "remove" | "sessions"; member: Membership }
  | { kind: "revoke_invite"; invitation: Invitation };

const CONFIRM_COPY = {
  suspend: {
    title: "Suspend user?",
    body: (who: string) => `${who} is signed out everywhere and cannot use this organization until reactivated. Their role and teams are kept.`,
    action: "Suspend",
    destructive: true,
  },
  reactivate: {
    title: "Reactivate user?",
    body: (who: string) => `${who} regains access with their previous role and teams.`,
    action: "Reactivate",
    destructive: false,
  },
  remove: {
    title: "Remove user?",
    body: (who: string) =>
      `${who} loses access immediately, is signed out everywhere and removed from all teams. Records they own stay in the CRM. To bring them back, invite them again.`,
    action: "Remove user",
    destructive: true,
  },
  sessions: {
    title: "Sign out everywhere?",
    body: (who: string) => `${who} is signed out of every browser and device. Their access is unchanged; they can sign in again.`,
    action: "Revoke sessions",
    destructive: true,
  },
} as const;

/** Settings → Users & Teams → Users. Every action is authorized again by the API; menus only hide what is not allowed. */
export function MembersPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  const { roles } = useRoles();

  const canInvite = hasPermission(active, "members.invite");
  const canUpdateRole = hasPermission(active, "members.update_role");
  const canSuspend = hasPermission(active, "members.disable");
  const canRemove = hasPermission(active, "members.remove");
  const canManageTeams = hasPermission(active, "teams.manage");
  const actorIsOwner = active?.role.key === "owner";

  const members = useCursorList(queryKeys.members, listMembers);
  const invitations = useCursorList(queryKeys.invitations, listInvitations, canInvite);
  const teams = useCursorList(queryKeys.teams, listTeams, canInvite || canManageTeams);

  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [roleTarget, setRoleTarget] = React.useState<Membership | null>(null);
  const [teamsTarget, setTeamsTarget] = React.useState<Membership | null>(null);
  const [confirm, setConfirm] = React.useState<Confirm | null>(null);

  const fail = (title: string) => (err: unknown) => {
    if (isReauthCancelled(err)) return;
    toast({ tone: "error", title, description: errorMessage(err) });
  };
  const refreshMembers = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.members }),
      queryClient.invalidateQueries({ queryKey: queryKeys.session }),
    ]);
  const nameOf = (m: Membership) => m.user.display_name || m.user.email;

  const roleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) => runSensitive(() => updateMemberRole(id, role)),
    onSuccess: async (updated) => {
      await refreshMembers();
      toast({ tone: "success", title: "Role updated", description: `${nameOf(updated)} is now ${updated.role.name}.` });
      setRoleTarget(null);
    },
    onError: fail("Could not update role"),
  });

  const teamsMutation = useMutation({
    mutationFn: ({ id, teamIds }: { id: string; teamIds: string[] }) => setMemberTeams(id, teamIds),
    onSuccess: async (updated) => {
      await Promise.all([refreshMembers(), queryClient.invalidateQueries({ queryKey: queryKeys.teams })]);
      toast({ tone: "success", title: "Teams updated", description: `${nameOf(updated)} teams were saved.` });
      setTeamsTarget(null);
    },
    onError: fail("Could not update teams"),
  });

  const confirmMutation = useMutation({
    mutationFn: async (target: Confirm) => {
      if (target.kind === "revoke_invite") return runSensitive(() => revokeInvitation(target.invitation.id));
      const id = target.member.id;
      if (target.kind === "suspend") return runSensitive(() => suspendMember(id));
      if (target.kind === "reactivate") return runSensitive(() => reactivateMember(id));
      if (target.kind === "remove") return runSensitive(() => removeMember(id));
      return runSensitive(() => revokeMemberSessions(id));
    },
    onSuccess: async (_data, target) => {
      const titles = {
        suspend: "User suspended",
        reactivate: "User reactivated",
        remove: "User removed",
        sessions: "Signed out everywhere",
        revoke_invite: "Invitation revoked",
      } as const;
      await Promise.all([refreshMembers(), queryClient.invalidateQueries({ queryKey: queryKeys.invitations })]);
      toast({ tone: "success", title: titles[target.kind] });
      setConfirm(null);
    },
    onError: fail("Could not complete the action"),
  });

  const resendMutation = useMutation({
    mutationFn: (id: string) => resendInvitation(id),
    onSuccess: async (invitation) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.invitations });
      toast({ tone: "success", title: "Invitation resent", description: `A new link was sent to ${invitation.email}. The previous link no longer works.` });
    },
    onError: fail("Could not resend invitation"),
  });

  const pendingInvitations = invitations.items.filter((i) => i.status === "pending" || i.status === "expired");
  const loading = members.isPending || (canInvite && invitations.isPending);
  const empty = members.items.length === 0 && pendingInvitations.length === 0;

  return (
    <div>
      <PageHeader
        title="Users & Teams"
        description="Invite people, set their role and team, and control their access."
        actions={
          canInvite ? (
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus /> Invite user
            </Button>
          ) : null
        }
      />
      <UsersTeamsTabs />

      {loading ? (
        <SkeletonRows rows={5} />
      ) : members.isError ? (
        <EmptyState
          title="Could not load users"
          description={errorMessage(members.error)}
          action={
            <Button variant="secondary" onClick={() => members.refetch()}>
              Retry
            </Button>
          }
        />
      ) : empty ? (
        <EmptyState icon={<Users />} title="No users yet" description="Invite colleagues to work in this organization." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead className="hidden lg:table-cell">Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="hidden md:table-cell">Team</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden xl:table-cell">MFA</TableHead>
              <TableHead className="hidden md:table-cell">Last login</TableHead>
              <TableHead className="hidden xl:table-cell">Joined</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pendingInvitations.map((inv) => (
              <TableRow key={`invitation-${inv.id}`}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <div className="flex size-7 items-center justify-center rounded-full bg-bg-subtle text-fg-subtle">
                      <MailPlus className="size-3.5" aria-hidden />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{inv.name || inv.email}</div>
                      <div className="truncate text-xs text-fg-subtle lg:hidden">{inv.email}</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="hidden text-fg-muted lg:table-cell">{inv.email}</TableCell>
                <TableCell>
                  <Badge variant={roleBadgeVariant(inv.role.key)}>{inv.role.name}</Badge>
                </TableCell>
                <TableCell className="hidden text-fg-muted md:table-cell">{inv.team?.name ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant={STATUS.invited.variant}>{inv.status === "expired" ? "Invite expired" : STATUS.invited.label}</Badge>
                </TableCell>
                <TableCell className="hidden text-fg-subtle xl:table-cell">—</TableCell>
                <TableCell className="hidden text-fg-subtle md:table-cell">—</TableCell>
                <TableCell className="hidden text-fg-muted xl:table-cell">Expires {formatDate(inv.expires_at)}</TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for invitation to ${inv.email}`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => resendMutation.mutate(inv.id)} disabled={resendMutation.isPending}>
                        <RefreshCw /> Resend invitation
                      </DropdownMenuItem>
                      <DropdownMenuItem destructive onSelect={() => setConfirm({ kind: "revoke_invite", invitation: inv })}>
                        <X /> Revoke invitation
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
            {members.items.map((m) => {
              const isSelf = m.id === active?.membership_id;
              const status = STATUS[m.display_status];
              const ownerProtected = m.role.key === "owner" && !actorIsOwner;
              const removed = m.status === "disabled";
              const actions = isSelf || ownerProtected ? [] : memberActions(m, { canUpdateRole, canSuspend, canRemove, canManageTeams, removed });
              return (
                <TableRow key={m.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar name={nameOf(m)} size="sm" />
                      <div className="min-w-0">
                        <div className="truncate font-medium">
                          {nameOf(m)}
                          {isSelf ? <span className="ml-1 text-xs text-fg-subtle">(you)</span> : null}
                        </div>
                        <div className="truncate text-xs text-fg-subtle lg:hidden">{m.user.email}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-fg-muted lg:table-cell">{m.user.email}</TableCell>
                  <TableCell>
                    <Badge variant={roleBadgeVariant(m.role.key)}>{m.role.name}</Badge>
                  </TableCell>
                  <TableCell className="hidden text-fg-muted md:table-cell">
                    {m.teams.length ? m.teams.map((t) => t.name).join(", ") : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </TableCell>
                  <TableCell className="hidden xl:table-cell">
                    {m.mfa_enabled ? (
                      <span className="inline-flex items-center gap-1 text-xs text-success">
                        <ShieldCheck className="size-3.5" aria-hidden /> On
                      </span>
                    ) : (
                      <span className="text-xs text-fg-subtle">Off</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden text-fg-muted md:table-cell">{m.last_login ? formatDateTime(m.last_login) : "Never"}</TableCell>
                  <TableCell className="hidden text-fg-muted xl:table-cell">{formatDate(m.joined_at)}</TableCell>
                  <TableCell>
                    {actions.length ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${m.user.email}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {actions.includes("role") ? (
                            <DropdownMenuItem onSelect={() => setRoleTarget(m)}>
                              <ShieldCheck /> Change role
                            </DropdownMenuItem>
                          ) : null}
                          {actions.includes("teams") ? (
                            <DropdownMenuItem onSelect={() => setTeamsTarget(m)}>
                              <UsersRound /> Assign team
                            </DropdownMenuItem>
                          ) : null}
                          {actions.includes("sessions") ? (
                            <DropdownMenuItem onSelect={() => setConfirm({ kind: "sessions", member: m })}>
                              <LogOut /> Revoke sessions
                            </DropdownMenuItem>
                          ) : null}
                          {actions.includes("suspend") ? (
                            <DropdownMenuItem destructive onSelect={() => setConfirm({ kind: "suspend", member: m })}>
                              <UserMinus /> Suspend
                            </DropdownMenuItem>
                          ) : null}
                          {actions.includes("reactivate") ? (
                            <DropdownMenuItem onSelect={() => setConfirm({ kind: "reactivate", member: m })}>
                              <UserCheck /> Reactivate
                            </DropdownMenuItem>
                          ) : null}
                          {actions.includes("remove") ? (
                            <DropdownMenuItem destructive onSelect={() => setConfirm({ kind: "remove", member: m })}>
                              <UserX /> Remove user
                            </DropdownMenuItem>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {members.hasMore ? (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" onClick={() => members.loadMore()} loading={members.isLoadingMore}>
            Load more
          </Button>
        </div>
      ) : null}

      <InviteMemberDialog open={inviteOpen} onOpenChange={setInviteOpen} roles={roles} teams={teams.items} />
      <ChangeRoleDialog
        member={roleTarget}
        roles={roles}
        onOpenChange={(open) => !open && setRoleTarget(null)}
        onSubmit={(role) => roleTarget && roleMutation.mutate({ id: roleTarget.id, role })}
        loading={roleMutation.isPending}
      />
      <AssignTeamsDialog
        member={teamsTarget}
        teams={teams.items}
        onOpenChange={(open) => !open && setTeamsTarget(null)}
        onSubmit={(teamIds) => teamsTarget && teamsMutation.mutate({ id: teamsTarget.id, teamIds })}
        loading={teamsMutation.isPending}
      />
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm === null ? "" : confirm.kind === "revoke_invite" ? "Revoke invitation?" : CONFIRM_COPY[confirm.kind].title}
        description={
          confirm === null
            ? ""
            : confirm.kind === "revoke_invite"
              ? `The invitation link sent to ${confirm.invitation.email} stops working.`
              : CONFIRM_COPY[confirm.kind].body(nameOf(confirm.member))
        }
        confirmLabel={confirm === null ? "" : confirm.kind === "revoke_invite" ? "Revoke" : CONFIRM_COPY[confirm.kind].action}
        destructive={confirm === null || confirm.kind === "revoke_invite" || CONFIRM_COPY[confirm.kind].destructive}
        loading={confirmMutation.isPending}
        onConfirm={() => confirm && confirmMutation.mutate(confirm)}
      />
    </div>
  );
}

type MemberAction = "role" | "teams" | "sessions" | "suspend" | "reactivate" | "remove";

export function memberActions(
  m: Membership,
  can: { canUpdateRole: boolean; canSuspend: boolean; canRemove: boolean; canManageTeams: boolean; removed: boolean },
): MemberAction[] {
  if (can.removed) return [];
  const actions: MemberAction[] = [];
  if (can.canUpdateRole) actions.push("role");
  if (can.canManageTeams) actions.push("teams");
  if (can.canSuspend) actions.push("sessions", m.status === "suspended" ? "reactivate" : "suspend");
  if (can.canRemove) actions.push("remove");
  return actions;
}
