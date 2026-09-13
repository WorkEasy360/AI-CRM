"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormError, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { createInvitation } from "@/lib/api/endpoints";
import { errorMessage, isApiError } from "@/lib/api/problem";
import type { RoleDefinition } from "@/lib/api/types";
import { queryKeys } from "@/lib/session";
import { inviteSchema, type InviteInput } from "@/lib/validation";

export function InviteMemberDialog({
  open,
  onOpenChange,
  roles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: RoleDefinition[];
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  const form = useForm<InviteInput>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: "", role: undefined as unknown as InviteInput["role"] },
  });

  const mutation = useMutation({
    mutationFn: createInvitation,
    onSuccess: async (invitation) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.invitations });
      toast({ tone: "success", title: "Invitation sent", description: `${invitation.email} was invited as ${invitation.role.name}.` });
      form.reset();
      onOpenChange(false);
    },
    onError: (err) => {
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
            <DialogTitle>Invite a member</DialogTitle>
            <DialogDescription>They will receive an email with a link to join this organization.</DialogDescription>
          </DialogHeader>
          <FormError message={fieldErrors.non_field_errors} />
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
