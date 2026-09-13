import * as React from "react";
import { cn } from "@/lib/utils";

/** Table shell: horizontal scroll container plus compact, lightly styled semantic table parts. */
export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  // ``relative`` keeps absolutely positioned descendants (sr-only labels in header cells) inside this
  // scroll container; without it they extend the document and phones get a horizontal scrollbar.
  return (
    <div className="relative w-full overflow-x-auto rounded-md border border-border bg-surface">
      <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("bg-surface-sunken text-left text-xs font-medium text-fg-subtle", className)} {...props} />;
}

export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn("divide-y divide-border", className)} {...props} />;
}

export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn("transition-colors hover:bg-bg-subtle/60", className)} {...props} />;
}

export function TableHead({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" className={cn("h-9 whitespace-nowrap px-3 font-medium", className)} {...props} />;
}

export function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-3 py-2 align-middle", className)} {...props} />;
}
