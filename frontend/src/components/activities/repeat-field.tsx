"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  MAX_COUNT,
  MAX_INTERVAL,
  WEEKDAY_LABELS,
  WEEKDAYS,
  buildRrule,
  describeRrule,
  parseRrule,
  weekdayOf,
  type RepeatEnd,
  type RepeatFreq,
  type RepeatRule,
} from "@/components/activities/recurrence";
import { cn } from "@/lib/utils";

const FREQ_OPTIONS: { value: Exclude<RepeatFreq, "custom">; label: string }[] = [
  { value: "none", label: "Does not repeat" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];
const UNITS: Record<string, [string, string]> = { daily: ["day", "days"], weekly: ["week", "weeks"], monthly: ["month", "months"], yearly: ["year", "years"] };
const END_OPTIONS: { value: RepeatEnd; label: string }[] = [
  { value: "never", label: "Never ends" },
  { value: "count", label: "Ends after" },
  { value: "until", label: "Ends on" },
];

/**
 * "Repeat" control for tasks and events. Edits an RRULE string (`value`); rules it cannot show
 * (set elsewhere) stay untouched as "Custom" until another option is picked.
 */
export function RepeatField({
  id,
  value,
  onChange,
  start,
  disabled,
  invalid,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** The activity's start/due date, used to preselect the weekday. */
  start: Date | null;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}) {
  const [rule, setRule] = React.useState<RepeatRule>(() => parseRrule(value));
  // Follow outside changes (form reset, reload) without clobbering a half-typed number.
  React.useEffect(() => {
    if (value !== buildRrule(rule)) setRule(parseRrule(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const update = (patch: Partial<RepeatRule>) => {
    const next = { ...rule, ...patch };
    setRule(next);
    onChange(buildRrule(next));
  };

  const pickFreq = (freq: RepeatFreq) => {
    if (freq === rule.freq) return;
    const days = freq === "weekly" && rule.days.length === 0 && start ? [weekdayOf(start)] : rule.days;
    update({ freq, days, raw: "" });
  };

  const toggleDay = (day: (typeof WEEKDAYS)[number]) => {
    const days = rule.days.includes(day) ? rule.days.filter((d) => d !== day) : [...rule.days, day];
    update({ days: WEEKDAYS.filter((d) => days.includes(d)) });
  };

  const repeating = rule.freq !== "none" && rule.freq !== "custom";
  const [one, many] = UNITS[rule.freq] ?? ["", ""];

  return (
    <div className="grid gap-2">
      <Select value={rule.freq} onValueChange={(v) => pickFreq(v as RepeatFreq)} disabled={disabled}>
        <SelectTrigger id={id} aria-invalid={invalid || undefined} aria-describedby={describedBy} className="h-8 sm:max-w-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FREQ_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
          {rule.freq === "custom" ? <SelectItem value="custom">{describeRrule(rule.raw)}</SelectItem> : null}
        </SelectContent>
      </Select>
      {repeating ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-fg-muted">
          <label className="inline-flex items-center gap-1.5">
            Every
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_INTERVAL}
              aria-label="Repeat every"
              value={rule.interval || ""}
              onChange={(e) => update({ interval: e.target.value === "" ? 0 : Number(e.target.value) })}
              disabled={disabled}
              className="h-8 w-16"
            />
            {rule.interval === 1 ? one : many}
          </label>
          {rule.freq === "weekly" ? (
            <div role="group" aria-label="Repeat on" className="inline-flex items-center gap-0.5">
              {WEEKDAYS.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={rule.days.includes(d)}
                  aria-label={WEEKDAY_LABELS[d].long}
                  title={WEEKDAY_LABELS[d].long}
                  disabled={disabled}
                  onClick={() => toggleDay(d)}
                  className={cn(
                    "inline-flex size-7 items-center justify-center rounded-full border text-xs font-medium transition-colors disabled:opacity-50",
                    rule.days.includes(d) ? "border-primary bg-primary-soft text-primary" : "border-border bg-surface text-fg-muted hover:text-fg",
                  )}
                >
                  {WEEKDAY_LABELS[d].short}
                </button>
              ))}
            </div>
          ) : null}
          <div className="inline-flex items-center gap-1.5">
            <Select value={rule.end} onValueChange={(v) => update({ end: v as RepeatEnd })} disabled={disabled}>
              <SelectTrigger aria-label="Ends" className="h-8 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {END_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {rule.end === "count" ? (
              <label className="inline-flex items-center gap-1.5">
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_COUNT}
                  aria-label="Number of times"
                  value={rule.count || ""}
                  onChange={(e) => update({ count: e.target.value === "" ? 0 : Number(e.target.value) })}
                  disabled={disabled}
                  className="h-8 w-20"
                />
                times
              </label>
            ) : null}
            {rule.end === "until" ? (
              <Input type="date" aria-label="End date" value={rule.until} onChange={(e) => update({ until: e.target.value })} disabled={disabled} className="h-8 w-40" />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
