import * as React from "react";

export function AuthHeading({ title, description }: { title: string; description?: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      {description ? <p className="mt-1 text-sm text-fg-muted">{description}</p> : null}
    </div>
  );
}
