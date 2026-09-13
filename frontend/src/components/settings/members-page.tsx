"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MailPlus, MoreHorizontal, ShieldCheck, UserMinus, UserPlus, Users } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { isReauthCancelled, useReauth } from "@/components/reauth-provider";
import { ChangeRoleDialog } from "@/components/settings/change-role-dialog";
import { InviteMemberDialog } from "@/components/settings/invite-member-dialog";
import { Avatar } from "@/components/ui/avatar";
import { Badge, roleBadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { disableMember, enableMember, listInvitations, listMembers, revokeInvitation, updateMemberRole } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/problem";
import type { Membership } from "@/lib/api/types";
import { useRoles } from "@/lib/roles";
import { hasPermission, queryKeys, useSession } from "@/lib/session";
import { useCursorList } from "@/lib/use-cursor-list";
import { formatDate } from "@/lib/utils";

export function MembersPage() {
  const { data: session } = useSession();
  const active = session?.active ?? null;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  const { roles } = useRoles();

  const canInvite = hasPermission(active, "members.invite");
  const canUpdateRole = hasPermission(active, "members.update_role");
  const canDisable = hasPermission(active, "members.disable");

  const members = useCursorList(queryKeys.members, listMembers);
  const invitations = useCursorList(queryKeys.invitations, listInvitations, canInvite);

  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [roleTarget, setRoleTarget] = React.useState<Membership | null>(null);
  const [statusTarget, setStatusTarget] = React.useState<Membership | null>(null);

  const fail = (title: string) => (err: unknown) => {
    if (isReauthCancelled(err)) return;
    toast({ tone: "error", title, description: errorMessage(err) });
  };

  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.members }), queryClient.invalidateQueries({ queryKey: queryKeys.session })]);

  const roleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) => runSensitive(() => updateMemberRole(id, role)),
    onSuccess: async (updated) => {
      await refresh();
      toast({ tone: "success", title: "Role updated", description: `${updated.user.display_name || updated.user.email} is now ${updated.role.name}.` });
      setRoleTarget(null);
    },
    onError: fail("Could not update role"),
  });

  const statusMutation = useMutation({
    mutationFn: (m: Membership) => runSensitive(() => (m.status === "active" ? disableMember(m.id) : enableMember(m.id))),
    onSuccess: async (updated) => {
      await refresh();
      toast({ tone: "success", title: updated.status === "active" ? "Member enabled" : "Member disabled" });
      setStatusTarget(null);
    },
    onError: fail("Could not change member status"),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => runSensitive(() => revokeInvitation(id)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.invitations });
      toast({ tone: "success", title: "Invitation revoked" });
    },
    onError: fail("Could not revoke invitation"),
  });

  const pendingInvitations = invitations.items.filter((i) => !i.status || i.status === "pending");

  return (
    <div>
      <PageHeader
        title="Members"
        description="People in this organization and the roles they hold."
        actions={
          canInvite ? (
            <Button onClick={() => setInviteOpen(true)}>
              <UserPlus /> Invite member
            </Button>
          ) : null
        }
      />

      {members.isPending ? (
        <SkeletonRows rows={5} />
      ) : members.isError ? (
        <EmptyState title="Could not load members" description={errorMessage(members.error)} action={<Button variant="secondary" onClick={() => members.refetch()}>Retry</Button>} />
      ) : members.items.length === 0 ? (
        <EmptyState icon={<Users />} title="No members yet" description="Invite colleagues to collaborate in this organization." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden md:table-cell">Joined</TableHead>
              <TableHead className="hidden md:table-cell">Last active</TableHead>
              <TableHead className="w-12">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.items.map((m) => {
              const isSelf = m.id === active?.membership_id;
              const isOwner = m.role.key === "owner";
              const canAct = (canUpdateRole || canDisable) && !isSelf;
              return (
                <TableRow key={m.id}>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <Avatar name={m.user.display_name || m.user.email} size="sm" />
                      <div className="min-w-0">
                        <div className="truncate font-medium">
                          {m.user.display_name || m.user.email}
                          {isSelf ? <span className="ml-1 text-xs text-fg-subtle">(you)</span> : null}
                        </div>
                        <div className="truncate text-xs text-fg-subtle">{m.user.email}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={roleBadgeVariant(m.role.key)}>{m.role.name}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={m.status === "active" ? "success" : "danger"}>{m.status === "active" ? "Active" : "Disabled"}</Badge>
                  </TableCell>
                  <TableCell className="hidden text-fg-muted md:table-cell">{formatDate(m.joined_at)}</TableCell>
                  <TableCell className="hidden text-fg-muted md:table-cell">{formatDate(m.last_active_at)}</TableCell>
                  <TableCell>
                    {canAct ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${m.user.email}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {canUpdateRole ? (
                            <DropdownMenuItem onSelect={() => setRoleTarget(m)}>
                              <ShieldCheck /> Change role
                            </DropdownMenuItem>
                          ) : null}
                          {canDisable && !isOwner ? (
                            <DropdownMenuItem destructive={m.status === "active"} onSelect={() => setStatusTarget(m)}>
                              <UserMinus /> {m.status === "active" ? "Disable member" : "Enable member"}
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

      {canInvite ? (
        <section className="mt-10">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-md font-semibold">Pending invitations</h2>
          </div>
          {invitations.isPending ? (
            <SkeletonRows rows={2} />
          ) : invitations.isError ? (
            <p className="text-sm text-danger">{errorMessage(invitations.error)}</p>
          ) : pendingInvitations.length === 0 ? (
            <EmptyState icon={<MailPlus />} title="No pending invitations" description="Invitations you send will appear here until they are accepted or expire." className="py-8" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="hidden sm:table-cell">Invited by</TableHead>
                  <TableHead className="hidden sm:table-cell">Expires</TableHead>
                  <TableHead className="w-24">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pendingInvitations.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="font-medium">{inv.email}</TableCell>
                    <TableCell>
                      <Badge variant={roleBadgeVariant(inv.role.key)}>{inv.role.name}</Badge>
                    </TableCell>
                    <TableCell className="hidden text-fg-muted sm:table-cell">{inv.invited_by?.display_name || inv.invited_by?.email}</TableCell>
                    <TableCell className="hidden text-fg-muted sm:table-cell">{formatDate(inv.expires_at)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="danger-ghost"
                        size="sm"
                        onClick={() => revokeMutation.mutate(inv.id)}
                        loading={revokeMutation.isPending && revokeMutation.variables === inv.id}
                      >
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {invitations.hasMore ? (
            <div className="mt-3 flex justify-center">
              <Button variant="secondary" onClick={() => invitations.loadMore()} loading={invitations.isLoadingMore}>
                Load more
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      <InviteMemberDialog open={inviteOpen} onOpenChange={setInviteOpen} roles={roles} />
      <ChangeRoleDialog
        member={roleTarget}
        roles={roles}
        onOpenChange={(open) => !open && setRoleTarget(null)}
        onSubmit={(role) => roleTarget && roleMutation.mutate({ id: roleTarget.id, role })}
        loading={roleMutation.isPending}
      />
      <ConfirmDialog
        open={statusTarget !== null}
        onOpenChange={(open) => !open && setStatusTarget(null)}
        title={statusTarget?.status === "active" ? "Disable member?" : "Enable member?"}
        description={
          statusTarget?.status === "active"
            ? `${statusTarget.user.email} will lose access to this organization immediately. You can enable them again later.`
            : `${statusTarget?.user.email} will regain access with their previous role.`
        }
        confirmLabel={statusTarget?.status === "active" ? "Disable" : "Enable"}
        destructive={statusTarget?.status === "active"}
        loading={statusMutation.isPending}
        onConfirm={() => statusTarget && statusMutation.mutate(statusTarget)}
      />
    </div>
  );
}
