"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import type { Membership, Team } from "@/lib/api/types";

export function AssignTeamsDialog({
  member,
  teams,
  onOpenChange,
  onSubmit,
  loading,
}: {
  member: Membership | null;
  teams: Team[];
  onOpenChange: (open: boolean) => void;
  onSubmit: (teamIds: string[]) => void;
  loading: boolean;
}) {
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    setSelected(new Set((member?.teams ?? []).map((t) => t.id)));
  }, [member]);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const unchanged =
    member !== null &&
    selected.size === member.teams.length &&
    member.teams.every((t) => selected.has(t.id));

  return (
    <Dialog open={member !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Assign teams</DialogTitle>
          <DialogDescription>
            {member ? `Choose the teams ${member.user.display_name || member.user.email} belongs to.` : null}
          </DialogDescription>
        </DialogHeader>
        {teams.length === 0 ? (
          <EmptyState title="No teams yet" description="Create teams on the Teams tab first." className="py-6" />
        ) : (
          <fieldset className="grid max-h-72 gap-1 overflow-y-auto">
            <legend className="sr-only">Teams</legend>
            {teams.map((team) => (
              <label key={team.id} className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-bg-subtle">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={selected.has(team.id)}
                  onChange={() => toggle(team.id)}
                />
                {team.name}
              </label>
            ))}
          </fieldset>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit([...selected])} disabled={unchanged || teams.length === 0} loading={loading}>
            Save teams
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
