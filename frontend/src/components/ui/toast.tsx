"use client";

import * as React from "react";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastTone = "info" | "success" | "error";

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  durationMs?: number;
}

interface ToastRecord extends ToastOptions {
  id: number;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

const icons: Record<ToastTone, React.ReactNode> = {
  info: <Info className="size-4 text-primary" aria-hidden />,
  success: <CheckCircle2 className="size-4 text-success" aria-hidden />,
  error: <AlertTriangle className="size-4 text-danger" aria-hidden />,
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastRecord[]>([]);
  const counter = React.useRef(0);

  const toast = React.useCallback((options: ToastOptions) => {
    counter.current += 1;
    const id = counter.current;
    setToasts((prev) => [...prev.slice(-4), { id, ...options }]);
  }, []);

  const dismiss = React.useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const value = React.useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitive.Provider swipeDirection="right" duration={5000}>
        {children}
        {toasts.map((t) => (
          <ToastPrimitive.Root
            key={t.id}
            duration={t.durationMs}
            onOpenChange={(open) => {
              if (!open) dismiss(t.id);
            }}
            className={cn(
              "grid grid-cols-[auto_1fr_auto] items-start gap-3 rounded-md border border-border bg-surface-raised p-4 text-fg shadow-lg animate-fade-in",
              "data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=end]:translate-x-full data-[state=closed]:opacity-0 transition-opacity",
              t.tone === "error" && "border-danger/40",
              t.tone === "success" && "border-success/40",
            )}
          >
            <span className="mt-0.5">{icons[t.tone ?? "info"]}</span>
            <div className="min-w-0">
              <ToastPrimitive.Title className="text-sm font-semibold">{t.title}</ToastPrimitive.Title>
              {t.description ? (
                <ToastPrimitive.Description className="mt-0.5 break-words text-sm text-fg-muted">{t.description}</ToastPrimitive.Description>
              ) : null}
            </div>
            <ToastPrimitive.Close className="rounded-sm p-1 text-fg-subtle hover:bg-bg-subtle hover:text-fg" aria-label="Dismiss">
              <X className="size-4" aria-hidden />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed bottom-4 right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}
