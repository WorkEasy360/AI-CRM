"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Membership, RoleDefinition } from "@/lib/api/types";

export function ChangeRoleDialog({
  member,
  roles,
  onOpenChange,
  onSubmit,
  loading,
}: {
  member: Membership | null;
  roles: RoleDefinition[];
  onOpenChange: (open: boolean) => void;
  onSubmit: (role: string) => void;
  loading: boolean;
}) {
  const [role, setRole] = React.useState<string>("");
  React.useEffect(() => {
    setRole(member?.role.key ?? "");
  }, [member]);

  const description = roles.find((r) => r.key === role)?.description;

  return (
    <Dialog open={member !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Change role</DialogTitle>
          <DialogDescription>
            {member ? `Update the role for ${member.user.display_name || member.user.email}.` : null}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="change-role-select">Role</Label>
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger id="change-role-select">
              <SelectValue placeholder="Choose a role" />
            </SelectTrigger>
            <SelectContent>
              {roles.map((r) => (
                <SelectItem key={r.key} value={r.key}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {description ? <p className="text-xs text-fg-subtle">{description}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={() => role && onSubmit(role)} disabled={!role || role === member?.role.key} loading={loading}>
            Save role
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
