import * as React from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex flex-wrap items-center justify-between gap-2", className)}>
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight text-fg">{title}</h1>
        {description ? (
          // Descriptions may be arbitrary nodes (chips, skeletons); <p> cannot hold block children.
          <Text className="mt-0.5 text-xs text-fg-muted">{description}</Text>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Renders a paragraph for plain text and a div for rich nodes, so nothing invalid nests inside <p>. */
function Text({ className, children }: { className?: string; children: React.ReactNode }) {
  const Tag = typeof children === "string" || typeof children === "number" ? "p" : "div";
  return <Tag className={className}>{children}</Tag>;
}
