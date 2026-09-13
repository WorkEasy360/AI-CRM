import { relativeTime } from "@/components/activities/activity-utils";
import { formatDateTime } from "@/lib/utils";

export function Dash() {
  return <span className="text-fg-subtle">—</span>;
}

/** "3 d ago" with the exact time on hover; a dash when nothing happened yet. */
export function LastActivityCell({ value }: { value: string | null | undefined }) {
  if (!value) return <Dash />;
  return (
    <time dateTime={value} title={formatDateTime(value)} className="whitespace-nowrap">
      {relativeTime(value)}
    </time>
  );
}

/** Next scheduled activity: title on the first line, relative date underneath (red when overdue). */
export function NextActivityCell({ at, title }: { at: string | null | undefined; title: string | null | undefined }) {
  if (!at && !title) return <Dash />;
  const overdue = at ? new Date(at).getTime() < Date.now() : false;
  return (
    <span className="flex min-w-0 flex-col leading-tight">
      {title ? <span className="truncate">{title}</span> : null}
      {at ? (
        <time dateTime={at} title={formatDateTime(at)} className={overdue ? "text-xs text-danger" : "text-xs text-fg-subtle"}>
          {relativeTime(at)}
        </time>
      ) : null}
    </span>
  );
}
