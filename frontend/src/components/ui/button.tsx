"use client";

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-sm font-medium transition-colors select-none disabled:pointer-events-none disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Filled actions turn neutral grey when disabled; the quiet variants simply fade.
        primary: "bg-brand text-brand-fg font-semibold hover:bg-brand-hover active:bg-brand-hover shadow-sm disabled:bg-bg-subtle disabled:text-fg-subtle disabled:shadow-none",
        accent: "bg-accent text-accent-fg hover:bg-accent-hover shadow-sm disabled:bg-bg-subtle disabled:text-fg-subtle disabled:shadow-none",
        secondary: "bg-surface text-fg border border-border-strong hover:bg-bg-subtle hover:border-fg-subtle/40 shadow-sm disabled:text-fg-subtle disabled:shadow-none disabled:opacity-70",
        ghost: "text-fg-muted hover:bg-bg-subtle hover:text-fg disabled:opacity-50",
        danger: "bg-danger text-danger-fg font-semibold hover:bg-danger-hover shadow-sm disabled:bg-bg-subtle disabled:text-fg-subtle disabled:shadow-none",
        "danger-ghost": "text-danger hover:bg-danger-soft disabled:opacity-50",
        link: "text-primary underline-offset-4 hover:underline h-auto px-0 disabled:opacity-50",
      },
      size: {
        sm: "h-8 px-3 text-sm [&_svg]:size-4",
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
      {asChild ? (
        // Slot needs exactly one element child: the loader placeholder must not be emitted here.
        children
      ) : (
        <>
          {loading ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {children}
        </>
      )}
    </Comp>
  );
});
