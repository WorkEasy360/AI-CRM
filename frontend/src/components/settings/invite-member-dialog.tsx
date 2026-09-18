"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { isReauthCancelled, useReauth } from "@/components/reauth-provider";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { createInvitation } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/problem";
import type { RoleDefinition, Team } from "@/lib/api/types";
import { queryKeys } from "@/lib/session";
import { inviteSchema, type InviteInput } from "@/lib/validation";

const NO_TEAM = "__none__";

/**
 * Invite = the person sets their own password from the emailed link. Administrators never choose or see
 * passwords. Only roles the inviter may grant are offered (the server enforces the same rule).
 */
export function InviteMemberDialog({
  open,
  onOpenChange,
  roles,
  teams = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: RoleDefinition[];
  teams?: Team[];
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  const form = useForm<InviteInput>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { name: "", email: "", role: undefined as unknown as InviteInput["role"], team_id: NO_TEAM },
  });

  const mutation = useMutation({
    // Inviting an owner or admin grants administrative control: the server may ask to re-authenticate.
    mutationFn: (values: InviteInput) =>
      runSensitive(() =>
        createInvitation({
          email: values.email,
          role: values.role,
          name: values.name?.trim() || "",
          team_id: values.team_id && values.team_id !== NO_TEAM ? values.team_id : null,
        }),
      ),
    onSuccess: async (invitation) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.invitations });
      toast({ tone: "success", title: "Invitation sent", description: `${invitation.email} was invited as ${invitation.role.name}.` });
      form.reset();
      onOpenChange(false);
    },
    onError: (err) => {
      if (isReauthCancelled(err)) return;
      if (isApiError(err) && err.isValidation) setFieldErrors(err.fieldErrors());
      else toast({ tone: "error", title: "Could not send invitation", description: errorMessage(err) });
    },
  });

  const onSubmit = form.handleSubmit((values) => {
    setFieldErrors({});
    mutation.mutate(values);
  });

  const invitableRoles = roles.filter((r) => r.key !== "owner");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          form.reset();
          setFieldErrors({});
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>Invite user</DialogTitle>
            <DialogDescription>They will get an email with a secure link to create their own password and join.</DialogDescription>
          </DialogHeader>
          <FormError message={fieldErrors.non_field_errors} />
          <FormField control={form.control} name="name" label="Name" serverError={fieldErrors.name}>
            {(field) => (
              <Input {...field} autoComplete="off" placeholder="Priya Sharma" value={field.value ?? ""} onChange={(e) => field.onChange(e.target.value)} />
            )}
          </FormField>
          <FormField control={form.control} name="email" label="Email" serverError={fieldErrors.email}>
            {(field) => (
              <Input
                {...field}
                type="email"
                autoComplete="off"
                placeholder="colleague@company.com"
                value={field.value}
                onChange={(e) => field.onChange(e.target.value)}
              />
            )}
          </FormField>
          <FormField control={form.control} name="role" label="Role" serverError={fieldErrors.role}>
            {(field) => (
              <Select value={field.value ?? ""} onValueChange={field.onChange}>
                <SelectTrigger id={field.id} aria-invalid={field["aria-invalid"]} aria-describedby={field["aria-describedby"]} aria-label="Role">
                  <SelectValue placeholder="Choose a role" />
                </SelectTrigger>
                <SelectContent>
                  {invitableRoles.map((r) => (
                    <SelectItem key={r.key} value={r.key}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          {teams.length > 0 ? (
            <FormField control={form.control} name="team_id" label="Team (optional)" serverError={fieldErrors.team_id}>
              {(field) => (
                <Select value={field.value ?? NO_TEAM} onValueChange={field.onChange}>
                  <SelectTrigger id={field.id} aria-label="Team">
                    <SelectValue placeholder="No team" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_TEAM}>No team</SelectItem>
                    {teams.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
