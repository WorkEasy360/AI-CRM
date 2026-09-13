"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm font-medium transition-colors select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-fg hover:bg-primary-hover shadow-sm",
        accent: "bg-accent text-accent-fg hover:bg-accent-hover shadow-sm",
        secondary: "bg-surface text-fg border border-border-strong hover:bg-bg-subtle shadow-sm",
        ghost: "text-fg-muted hover:bg-bg-subtle hover:text-fg",
        danger: "bg-danger text-danger-fg hover:bg-danger-hover shadow-sm",
        "danger-ghost": "text-danger hover:bg-danger-soft",
        link: "text-primary underline-offset-4 hover:underline h-auto px-0",
      },
      size: {
        sm: "h-8 px-3 text-xs [&_svg]:size-3.5",
        md: "h-9 px-4 text-sm [&_svg]:size-4",
        lg: "h-11 px-5 text-md [&_svg]:size-4",
        icon: "size-9 [&_svg]:size-4",
        "icon-sm": "size-8 [&_svg]:size-4",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, loading = false, disabled, children, ...props },
  ref,
) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...(asChild ? {} : { type: props.type ?? "button" })}
      {...props}
    >
      {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
      {children}
    </Comp>
  );
});
