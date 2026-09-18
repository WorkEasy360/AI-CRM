"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Lock, Plus, Trash2 } from "lucide-react";
import { isReauthCancelled, useReauth } from "@/components/reauth-provider";
import { directionLabel, fieldLabel } from "@/components/settings/integrations/labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { FormError } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import {
  integrationKeys,
  updateConnectionSharing,
  type ConnectionDetail,
  type IntegrationOptions,
  type OptionEntity,
  type SharingDirection,
  type SharingPolicy,
} from "@/lib/api/integrations";
import { errorMessage, isApiError } from "@/lib/api/problem";

/** CRM fields a policy may map: what may leave for outbound, what may be written for inbound, both for two-way. */
export function allowedFields(entity: OptionEntity, direction: SharingDirection): string[] {
  const outbound = entity.outbound_fields ?? [];
  const inbound = entity.inbound_fields ?? [];
  switch (direction) {
    case "outbound":
      return outbound;
    case "inbound":
      return inbound;
    case "two_way":
      return outbound.filter((field) => inbound.includes(field));
    default:
      return [];
  }
}

interface MappingRow {
  key: number;
  crm_field: string;
  external_field: string;
}

interface SharingErrors {
  direction?: string;
  external_resource?: string;
  mappings: string[];
  general: string[];
}

const NO_ERRORS: SharingErrors = { mappings: [], general: [] };

let rowSequence = 0;
function makeRow(crm_field = "", external_field = ""): MappingRow {
  rowSequence += 1;
  return { key: rowSequence, crm_field, external_field };
}

function signature(policy: SharingPolicy): string {
  const mappings = [...policy.mappings].sort((a, b) => `${a.crm_field}|${a.external_field}`.localeCompare(`${b.crm_field}|${b.external_field}`));
  return JSON.stringify({ ...policy, mappings });
}

export function SharingEditor({ connection, options, canManage }: { connection: ConnectionDetail; options: IntegrationOptions; canManage: boolean }) {
  const webhookOnly = connection.auth_type === "signed_webhook";
  return (
    <div className="grid gap-4">
      <p className="text-sm text-fg-muted">
        Choose which CRM data this connection may read or change, and which fields line up with the external system. Only the fields you map are exchanged.
        {webhookOnly ? " This connection only receives data through its inbound webhook." : ""}
      </p>
      {options.entities.map((entity) => {
        if (!entity.shareable) return <LockedEntityCard key={entity.key} entity={entity} />;
        const policy: SharingPolicy = connection.sharing.find((p) => p.entity_type === entity.key) ?? {
          entity_type: entity.key,
          direction: "none",
          external_resource: "",
          mappings: [],
        };
        // Remount when the saved policy changes so the editor starts from what the server stored.
        return <EntitySharingCard key={`${entity.key}:${signature(policy)}`} connection={connection} entity={entity} policy={policy} options={options} canManage={canManage} />;
      })}
    </div>
  );
}

function LockedEntityCard({ entity }: { entity: OptionEntity }) {
  const reasonId = `sharing-${entity.key}-reason`;
  return (
    <Card>
      <CardHeader className="border-b-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              {entity.label}
              <Badge variant="neutral">
                <Lock className="size-3" aria-hidden /> Never shared
              </Badge>
            </CardTitle>
            <CardDescription id={reasonId}>{entity.reason || "This data cannot be shared with integrations."}</CardDescription>
          </div>
          <div className="w-full sm:w-56">
            <Select value="none" disabled>
              <SelectTrigger aria-label={`${entity.label} sharing direction`} aria-describedby={reasonId}>
                <SelectValue placeholder="Not shared" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not shared</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
    </Card>
  );
}

function EntitySharingCard({
  connection,
  entity,
  policy,
  options,
  canManage,
}: {
  connection: ConnectionDetail;
  entity: OptionEntity;
  policy: SharingPolicy;
  options: IntegrationOptions;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { runSensitive } = useReauth();
  const webhookOnly = connection.auth_type === "signed_webhook";
  const [direction, setDirection] = React.useState<SharingDirection>(policy.direction);
  const [resource, setResource] = React.useState(policy.external_resource);
  const [rows, setRows] = React.useState<MappingRow[]>(() =>
    policy.mappings.length ? policy.mappings.map((m) => makeRow(m.crm_field, m.external_field)) : policy.direction === "none" ? [] : [makeRow()],
  );
  const [errors, setErrors] = React.useState<SharingErrors>(NO_ERRORS);

  const fields = allowedFields(entity, direction);
  const directions = options.directions.filter((d) => !webhookOnly || d.key === "none" || d.key === "inbound");
  const disabled = !canManage;
  const idBase = `sharing-${entity.key}`;

  const payload = (): SharingPolicy =>
    direction === "none"
      ? { entity_type: entity.key, direction: "none", external_resource: "", mappings: [] }
      : {
          entity_type: entity.key,
          direction,
          external_resource: webhookOnly ? "" : resource.trim(),
          mappings: rows.filter((r) => r.crm_field && r.external_field.trim()).map((r) => ({ crm_field: r.crm_field, external_field: r.external_field.trim() })),
        };

  const hasIncompleteRow = direction !== "none" && rows.some((r) => Boolean(r.crm_field) !== Boolean(r.external_field.trim()));
  const dirty = hasIncompleteRow || signature(payload()) !== signature(policy);

  const save = useMutation({
    mutationFn: (body: SharingPolicy) => runSensitive(() => updateConnectionSharing(connection.id, body)),
    onSuccess: async (detail, body) => {
      toast({ tone: "success", title: body.direction === "none" ? `${entity.label} no longer shared` : `${entity.label} sharing saved` });
      queryClient.setQueryData(integrationKeys.connection(connection.id), detail);
      await queryClient.invalidateQueries({ queryKey: integrationKeys.catalog });
    },
    onError: (err) => {
      if (isReauthCancelled(err)) return;
      if (isApiError(err) && err.status === 400 && err.problem.errors?.length) {
        const next: SharingErrors = { mappings: [], general: [] };
        for (const e of err.problem.errors) {
          if (e.field === "direction") next.direction ??= e.message;
          else if (e.field === "external_resource") next.external_resource ??= e.message;
          else if (e.field === "mappings" || e.field.startsWith("mappings.")) next.mappings.push(e.message);
          else next.general.push(e.message);
        }
        setErrors(next);
        return;
      }
      toast({ tone: "error", title: `Could not save ${entity.label.toLowerCase()} sharing`, description: errorMessage(err) });
    },
  });

  const changeDirection = (value: string) => {
    const next = value as SharingDirection;
    setDirection(next);
    setErrors(NO_ERRORS);
    if (next === "none") return;
    const allowed = allowedFields(entity, next);
    // Fields that are not allowed in the new direction are cleared rather than silently sent.
    setRows((current) => {
      const kept = current.map((r) => (r.crm_field && !allowed.includes(r.crm_field) ? { ...r, crm_field: "" } : r));
      return kept.length ? kept : [makeRow()];
    });
  };

  const updateRow = (key: number, patch: Partial<MappingRow>) => setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const onSave = () => {
    if (hasIncompleteRow) {
      setErrors({ mappings: ["Choose a CRM field and enter the external field name on every row, or remove the row."], general: [] });
      return;
    }
    setErrors(NO_ERRORS);
    save.mutate(payload());
  };

  const directionErrorId = `${idBase}-direction-error`;
  const resourceErrorId = `${idBase}-resource-error`;
  const mappingErrorId = `${idBase}-mapping-error`;

  return (
    <Card>
      <CardHeader className={direction === "none" ? "border-b-0" : undefined}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>{entity.label}</CardTitle>
            <CardDescription>
              {direction === "none"
                ? "Not shared with this connection."
                : `${directionLabel(direction, options.directions)} · ${rows.filter((r) => r.crm_field).length} mapped field${rows.filter((r) => r.crm_field).length === 1 ? "" : "s"}`}
            </CardDescription>
          </div>
          <div className="grid w-full gap-1 sm:w-56">
            <Select value={direction} onValueChange={changeDirection} disabled={disabled}>
              <SelectTrigger
                aria-label={`${entity.label} sharing direction`}
                aria-invalid={errors.direction ? true : undefined}
                aria-describedby={errors.direction ? directionErrorId : undefined}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {directions.map((d) => (
                  <SelectItem key={d.key} value={d.key}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.direction ? (
              <p id={directionErrorId} role="alert" className="text-xs text-danger">
                {errors.direction}
              </p>
            ) : null}
          </div>
        </div>
      </CardHeader>

      {direction !== "none" ? (
        <CardContent className="grid gap-4">
          {errors.general.length ? <FormError message={errors.general.join(" ")} /> : null}
          {webhookOnly ? null : (
            <div className="grid gap-1.5 sm:max-w-md">
              <Label htmlFor={`${idBase}-resource`}>API path</Label>
              <Input
                id={`${idBase}-resource`}
                value={resource}
                onChange={(e) => setResource(e.target.value)}
                placeholder={`/${entity.key === "company" ? "companies" : `${entity.key}s`}`}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                aria-invalid={errors.external_resource ? true : undefined}
                aria-describedby={errors.external_resource ? resourceErrorId : `${idBase}-resource-help`}
              />
              {errors.external_resource ? (
                <p id={resourceErrorId} role="alert" className="text-xs text-danger">
                  {errors.external_resource}
                </p>
              ) : (
                <p id={`${idBase}-resource-help`} className="text-xs text-fg-subtle">
                  Path relative to the connection&apos;s base URL where these records live.
                </p>
              )}
            </div>
          )}

          <fieldset className="grid gap-2" aria-describedby={errors.mappings.length ? mappingErrorId : undefined}>
            <legend className="mb-1 text-sm font-medium">Field mapping</legend>
            {fields.length === 0 ? (
              <p className="text-sm text-fg-muted">No fields can be exchanged in this direction.</p>
            ) : (
              <>
                <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem] gap-2 text-xs text-fg-subtle sm:grid">
                  <span>CRM field</span>
                  <span>External field</span>
                  <span className="sr-only">Remove</span>
                </div>
                {rows.map((row, index) => (
                  <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem] items-center gap-2">
                    <Select value={row.crm_field} onValueChange={(value) => updateRow(row.key, { crm_field: value })} disabled={disabled}>
                      <SelectTrigger aria-label={`${entity.label} CRM field ${index + 1}`}>
                        <SelectValue placeholder="Choose a field" />
                      </SelectTrigger>
                      <SelectContent>
                        {fields.map((field) => (
                          <SelectItem key={field} value={field}>
                            {fieldLabel(field)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      aria-label={`${entity.label} external field ${index + 1}`}
                      value={row.external_field}
                      onChange={(e) => updateRow(row.key, { external_field: e.target.value })}
                      placeholder="externalFieldName"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={disabled}
                    />
                    {canManage ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${entity.label.toLowerCase()} mapping ${index + 1}`}
                        onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                      >
                        <Trash2 />
                      </Button>
                    ) : (
                      <span />
                    )}
                  </div>
                ))}
                {canManage ? (
                  <div>
                    <Button variant="ghost" size="sm" onClick={() => setRows((current) => [...current, makeRow()])}>
                      <Plus /> Add field
                    </Button>
                  </div>
                ) : null}
              </>
            )}
            {errors.mappings.length ? (
              <ul id={mappingErrorId} role="alert" className="grid gap-0.5 text-xs text-danger">
                {errors.mappings.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            ) : null}
          </fieldset>
        </CardContent>
      ) : errors.general.length || errors.mappings.length ? (
        <CardContent>
          <FormError message={[...errors.general, ...errors.mappings].join(" ")} />
        </CardContent>
      ) : null}

      {canManage && (policy.direction !== "none" || direction !== "none") ? (
        <CardFooter className="justify-end">
          <Button size="sm" onClick={onSave} disabled={!dirty} loading={save.isPending}>
            Save {entity.label.toLowerCase()}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
