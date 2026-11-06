import * as React from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  icon: Icon,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** The module's icon, drawn large in brand green beside the title (the WorkEasy360 page header). */
  icon?: React.ComponentType<{ className?: string }>;
  className?: string;
}) {
  if (Icon) {
    return (
      <div className={cn("mb-4 flex flex-wrap items-center justify-between gap-3", className)}>
        <div className="flex min-w-0 items-center gap-3">
          <Icon className="size-10 shrink-0 text-brand" aria-hidden />
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-fg">{title}</h1>
            {description ? <Text className="mt-0.5 text-sm text-fg-muted">{description}</Text> : null}
          </div>
        </div>
        {actions ? <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    );
  }
  return (
    <div className={cn("mb-3 flex flex-wrap items-center justify-between gap-2", className)}>
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight text-fg">{title}</h1>
        {description ? (
          // Descriptions may be arbitrary nodes (chips, skeletons); <p> cannot hold block children.
          <Text className="mt-0.5 text-xs text-fg-muted">{description}</Text>
        ) : null}
      </div>
      {actions ? <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Renders a paragraph for plain text and a div for rich nodes, so nothing invalid nests inside <p>. */
function Text({ className, children }: { className?: string; children: React.ReactNode }) {
  const Tag = typeof children === "string" || typeof children === "number" ? "p" : "div";
  return <Tag className={className}>{children}</Tag>;
}
