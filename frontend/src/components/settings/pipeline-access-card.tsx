"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { setPipelineAccess, updatePipeline } from "@/lib/api/crm";
import type { Pipeline } from "@/lib/api/crm-types";
import { listTeams } from "@/lib/api/endpoints";
import { errorMessage } from "@/lib/api/problem";
import { listHierarchyRoles } from "@/lib/api/roles";
import { crmKeys } from "@/lib/crm/keys";
import { useModuleSchema } from "@/lib/views";

const MAX_CARD_FIELDS = 8;

/**
 * Who may use a team pipeline (restricted to teams and/or hierarchy roles; pipeline managers always
 * see every pipeline) and which deal fields its Kanban cards show. Sub-pipelines inherit both.
 */
export function PipelineAccessCard({ pipeline, parent, canManage }: { pipeline: Pipeline; parent: Pipeline | null; canManage: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const isVariant = Boolean(pipeline.parent_id);
  const [teamIds, setTeamIds] = React.useState<string[]>(pipeline.access.team_ids);
  const [roleIds, setRoleIds] = React.useState<string[]>(pipeline.access.hierarchy_role_ids);
  const [cardFields, setCardFields] = React.useState<string[]>(pipeline.layout.card_fields ?? []);
  const teams = useQuery({ queryKey: ["teams", "all"], queryFn: () => listTeams(), enabled: canManage && !isVariant });
  const roles = useQuery({ queryKey: ["hierarchy-roles"], queryFn: listHierarchyRoles, enabled: canManage && !isVariant });
  const schema = useModuleSchema("deal");
  const invalidate = () => Promise.all([qc.invalidateQueries({ queryKey: crmKeys.pipelines }), qc.invalidateQueries({ queryKey: ["crm", "deals", "board"] })]);
  const fail = (title: string) => (error: unknown) => toast({ tone: "error", title, description: errorMessage(error) });

  const restrict = useMutation({
    mutationFn: (restricted: boolean) => updatePipeline(pipeline.id, { restricted, version: pipeline.version }),
    onSuccess: invalidate,
    onError: fail("Could not change who sees this pipeline"),
  });
  const saveAccess = useMutation({
    mutationFn: () => setPipelineAccess(pipeline.id, { team_ids: teamIds, hierarchy_role_ids: roleIds }),
    onSuccess: async () => {
      await invalidate();
      toast({ tone: "success", title: "Access saved" });
    },
    onError: fail("Could not save access"),
  });
  const saveLayout = useMutation({
    mutationFn: () => updatePipeline(pipeline.id, { layout: { ...pipeline.layout, card_fields: cardFields }, version: pipeline.version }),
    onSuccess: async () => {
      await invalidate();
      toast({ tone: "success", title: "Card layout saved" });
    },
    onError: fail("Could not save the layout"),
  });

  if (isVariant) {
    return (
      <Card>
        <CardContent className="px-4 py-3 text-sm text-fg-muted">
          A sub-pipeline of <span className="font-medium text-fg">{parent?.name ?? "its team pipeline"}</span>: it uses that pipeline’s access and card layout, with its own stages.
        </CardContent>
      </Card>
    );
  }

  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const cardChoices = (schema.data?.fields ?? []).filter((f) => !["name", "tags", "pipeline"].includes(f.key) && f.type !== "textarea");

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 px-4 py-4">
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                <Lock className="size-3.5" aria-hidden /> Restrict to teams or roles
              </h3>
              <p className="text-xs text-fg-muted">When on, only the chosen teams and roles (and pipeline managers) see this pipeline and its deals.</p>
            </div>
            <Switch checked={pipeline.restricted} disabled={!canManage || restrict.isPending} onCheckedChange={(v) => restrict.mutate(v)} aria-label="Restrict this pipeline" />
          </div>
          {pipeline.restricted ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <fieldset className="rounded-sm border border-border p-2">
                <legend className="px-1 text-xs font-medium text-fg-muted">Teams</legend>
                {(teams.data?.results ?? []).map((t) => (
                  <label key={t.id} className="flex items-center gap-2 py-0.5 text-sm">
                    <input type="checkbox" disabled={!canManage} checked={teamIds.includes(t.id)} onChange={() => toggle(teamIds, setTeamIds, t.id)} />
                    {t.name}
                  </label>
                ))}
                {teams.isSuccess && (teams.data?.results ?? []).length === 0 ? <p className="text-xs text-fg-subtle">No teams yet.</p> : null}
              </fieldset>
              <fieldset className="rounded-sm border border-border p-2">
                <legend className="px-1 text-xs font-medium text-fg-muted">Roles</legend>
                {(roles.data ?? []).map((r) => (
                  <label key={r.id} className="flex items-center gap-2 py-0.5 text-sm">
                    <input type="checkbox" disabled={!canManage} checked={roleIds.includes(r.id)} onChange={() => toggle(roleIds, setRoleIds, r.id)} />
                    {r.name}
                  </label>
                ))}
                {roles.isSuccess && (roles.data ?? []).length === 0 ? <p className="text-xs text-fg-subtle">No roles yet.</p> : null}
              </fieldset>
              {canManage ? (
                <div className="sm:col-span-2">
                  <Button size="sm" variant="secondary" onClick={() => saveAccess.mutate()} loading={saveAccess.isPending}>
                    Save access
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        <section className="flex flex-col gap-2 border-t border-border pt-3">
          <div>
            <h3 className="text-sm font-semibold">Card layout</h3>
            <p className="text-xs text-fg-muted">Extra deal fields shown on this pipeline’s Kanban cards (up to {MAX_CARD_FIELDS}).</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {cardChoices.map((f) => {
              const on = cardFields.includes(f.key);
              return (
                <button
                  key={f.key}
                  type="button"
                  disabled={!canManage || (!on && cardFields.length >= MAX_CARD_FIELDS)}
                  aria-pressed={on}
                  onClick={() => toggle(cardFields, setCardFields, f.key)}
                  className={on ? "rounded-full border border-primary bg-primary-soft px-2 py-0.5 text-xs text-primary" : "rounded-full border border-border px-2 py-0.5 text-xs text-fg-muted hover:text-fg disabled:opacity-50"}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
          {canManage ? (
            <div>
              <Button size="sm" variant="secondary" onClick={() => saveLayout.mutate()} loading={saveLayout.isPending}>
                Save layout
              </Button>
            </div>
          ) : null}
        </section>
      </CardContent>
    </Card>
  );
}
