import * as React from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
}

export function EmptyState({ icon, title, description, action, className, ...props }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border-strong bg-surface px-6 py-12 text-center",
        className,
      )}
      {...props}
    >
      {icon ? (
        <div className="flex size-12 items-center justify-center rounded-full bg-primary-soft text-primary [&_svg]:size-6">{icon}</div>
      ) : null}
      <h3 className="text-md font-semibold text-fg">{title}</h3>
      {description ? <p className="max-w-md text-sm text-fg-muted">{description}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
