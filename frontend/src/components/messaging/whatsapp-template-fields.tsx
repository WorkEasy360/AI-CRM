"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { WhatsAppTemplate } from "@/lib/api/crm-types";

/** Templates Meta has approved; only those may be sent outside the 24-hour window. */
export function approvedTemplates(templates: WhatsAppTemplate[]): WhatsAppTemplate[] {
  return templates.filter((t) => t.status.toLowerCase() === "approved");
}

/** Substitute `{{1}}`… with the given values; unfilled slots stay visible so the gap is obvious. */
export function fillTemplate(body: string, params: string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (match, index: string) => {
    const value = params[Number(index) - 1];
    return value && value.trim() ? value : match;
  });
}

export function countTemplateParams(body: string): number {
  let max = 0;
  for (const match of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, Number(match[1]));
  return max;
}

/** Template picker, one input per `{{n}}` placeholder and a live preview. */
export function WhatsAppTemplateFields({
  templates,
  templateId,
  onTemplateChange,
  params,
  onParamsChange,
  errors,
  disabled,
}: {
  templates: WhatsAppTemplate[];
  templateId: string;
  onTemplateChange: (id: string) => void;
  params: string[];
  onParamsChange: (params: string[]) => void;
  errors: Record<string, string>;
  disabled?: boolean;
}) {
  const baseId = React.useId();
  const template = templates.find((t) => t.id === templateId) ?? null;
  const count = template ? Math.max(template.parameter_count, countTemplateParams(template.body)) : 0;
  const slots = Array.from({ length: count }, (_, i) => params[i] ?? "");

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor={`${baseId}-template`}>Template</Label>
        <Select value={templateId} onValueChange={onTemplateChange} disabled={disabled || templates.length === 0}>
          <SelectTrigger id={`${baseId}-template`} aria-invalid={errors.template_id ? true : undefined}>
            <SelectValue placeholder={templates.length === 0 ? "No approved templates" : "Choose a template"} />
          </SelectTrigger>
          <SelectContent>
            {templates.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name} <span className="text-fg-subtle">· {t.language}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {errors.template_id ? (
          <p role="alert" className="text-xs text-danger">
            {errors.template_id}
          </p>
        ) : null}
      </div>

      {template ? (
        <>
          {count > 0 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {slots.map((value, index) => (
                <div key={index} className="grid gap-1.5">
                  <Label htmlFor={`${baseId}-param-${index + 1}`}>{`Value for {{${index + 1}}}`}</Label>
                  <Input
                    id={`${baseId}-param-${index + 1}`}
                    className="h-8"
                    maxLength={200}
                    value={value}
                    disabled={disabled}
                    onChange={(e) => {
                      const next = [...slots];
                      next[index] = e.target.value;
                      onParamsChange(next);
                    }}
                  />
                </div>
              ))}
            </div>
          ) : null}
          {errors.template_params ? (
            <p role="alert" className="text-xs text-danger">
              {errors.template_params}
            </p>
          ) : null}
          <div className="grid gap-1">
            <span className="text-xs font-medium text-fg-muted">Preview</span>
            <p className="whitespace-pre-wrap break-words rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm">{fillTemplate(template.body, slots) || "(empty template body)"}</p>
          </div>
        </>
      ) : null}
    </div>
  );
}
