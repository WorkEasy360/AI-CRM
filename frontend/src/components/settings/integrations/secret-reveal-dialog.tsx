"use client";

import * as React from "react";
import { AlertTriangle, Copy } from "lucide-react";
import { copyToClipboard } from "@/components/settings/integrations/labels";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";

export interface RevealItem {
  label: string;
  value: string;
}

/**
 * A one-time reveal. Lives only in the state of the component that opened it; closing the dialog must
 * drop the whole object (the parent sets it back to `null`), so the value is gone from memory and the DOM.
 */
export interface SecretReveal {
  title: string;
  description?: React.ReactNode;
  items: RevealItem[];
  /** Why the value cannot be shown again, or what happens to the previous one. */
  warning: string;
  /** Usage hints for the developer (headers, signature format). */
  children?: React.ReactNode;
}

export function SecretRevealDialog({ reveal, onClose }: { reveal: SecretReveal | null; onClose: () => void }) {
  const { toast } = useToast();

  const copy = async (item: RevealItem) => {
    const ok = await copyToClipboard(item.value);
    toast(ok ? { tone: "success", title: `${item.label} copied` } : { tone: "error", title: "Copy failed", description: "Select the value and copy it manually." });
  };

  return (
    <Dialog open={reveal !== null} onOpenChange={(open) => !open && onClose()}>
      {reveal ? (
        <DialogContent
          className="max-w-xl"
          // A stray click outside must not throw away a value that can never be shown again.
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>{reveal.title}</DialogTitle>
            {reveal.description ? <DialogDescription>{reveal.description}</DialogDescription> : null}
          </DialogHeader>
          <div role="alert" className="flex items-start gap-2 rounded-sm border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{reveal.warning}</span>
          </div>
          <div className="grid gap-3">
            {reveal.items.map((item) => (
              <div key={item.label} className="grid gap-1.5">
                <p className="text-sm font-medium">{item.label}</p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-sm bg-bg-subtle px-2 py-1.5 font-mono text-xs" data-secret-value>
                    {item.value}
                  </code>
                  <Button variant="secondary" size="sm" aria-label={`Copy ${item.label.toLowerCase()}`} onClick={() => void copy(item)}>
                    <Copy /> Copy
                  </Button>
                </div>
              </div>
            ))}
          </div>
          {reveal.children ? <div className="grid gap-2 text-sm text-fg-muted">{reveal.children}</div> : null}
          <DialogFooter>
            <Button onClick={onClose}>I have saved it</Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

/** Pre-formatted developer snippet (headers, payload shape). Plain text only. */
export function CodeBlock({ children, label }: { children: string; label?: string }) {
  return (
    <pre aria-label={label} className="overflow-x-auto whitespace-pre rounded-sm bg-bg-subtle px-3 py-2 font-mono text-xs text-fg">
      {children}
    </pre>
  );
}
