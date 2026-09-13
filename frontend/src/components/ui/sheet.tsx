"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** Sheet / Drawer: an edge-anchored panel built on the Radix Dialog primitive. */
export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetTitle = DialogPrimitive.Title;
export const SheetDescription = DialogPrimitive.Description;

type Side = "left" | "right";

export const SheetContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { side?: Side }
>(function SheetContent({ className, children, side = "right", ...props }, ref) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-overlay animate-fade-in" />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed inset-y-0 z-50 flex w-[min(20rem,calc(100%-3rem))] flex-col border-border bg-surface-raised text-fg shadow-lg",
          side === "left" ? "left-0 border-r animate-slide-in-left" : "right-0 border-l animate-slide-in-right",
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close className="absolute right-3 top-3 rounded-sm p-1 text-fg-subtle hover:bg-bg-subtle hover:text-fg">
          <X className="size-4" aria-hidden />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});
