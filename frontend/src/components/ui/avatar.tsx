"use client";

import * as React from "react";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn, initials } from "@/lib/utils";

export interface AvatarProps extends React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root> {
  name?: string | null;
  size?: "sm" | "md" | "lg";
}

const sizes = { sm: "size-7 text-[12px]", md: "size-9 text-xs", lg: "size-12 text-sm" };

export const Avatar = React.forwardRef<React.ComponentRef<typeof AvatarPrimitive.Root>, AvatarProps>(function Avatar(
  { className, name, size = "md", ...props },
  ref,
) {
  return (
    <AvatarPrimitive.Root
      ref={ref}
      className={cn("relative flex shrink-0 overflow-hidden rounded-full", sizes[size], className)}
      {...props}
    >
      <AvatarPrimitive.Fallback
        className="flex size-full items-center justify-center rounded-full bg-primary-soft font-semibold uppercase text-primary"
        delayMs={0}
      >
        {initials(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
});
