"use client";

import * as React from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { isApiError, type UpgradeInfo } from "@/lib/api/problem";

interface UpgradeEvent {
  info: UpgradeInfo;
  message: string;
}

type Listener = (event: UpgradeEvent) => void;
const listeners = new Set<Listener>();

/**
 * Offer the upgrade path when the plan blocked an action. Wired into the QueryClient's caches, so every
 * request in the app gets it without each page handling plan errors itself.
 */
export function reportPlanBoundary(error: unknown): void {
  if (!isApiError(error) || !error.upgrade) return;
  const event = { info: error.upgrade, message: error.summary() };
  listeners.forEach((listener) => listener(event));
}

export function UpgradePromptHost() {
  const [event, setEvent] = React.useState<UpgradeEvent | null>(null);

  React.useEffect(() => {
    const listener: Listener = (next) => setEvent(next);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const target = event?.info.required_edition;
  const title = target ? `Upgrade to ${target.name}` : "You've reached your plan limit";

  return (
    <Dialog open={event !== null} onOpenChange={(open) => !open && setEvent(null)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-primary-soft text-primary">
            <Sparkles className="size-5" aria-hidden />
          </div>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{event?.message}</DialogDescription>
        </DialogHeader>
        {event?.info.kind === "limit" && typeof event.info.limit === "number" ? (
          <p className="text-sm text-fg-muted">
            {event.info.label ?? "Usage"}: {event.info.used?.toLocaleString() ?? "?"} of {event.info.limit.toLocaleString()} used.
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onClick={() => setEvent(null)}>
            Not now
          </Button>
          <Button asChild onClick={() => setEvent(null)}>
            <Link href={event?.info.url ?? "/settings/billing"}>{target ? "Compare plans" : "View add-ons"}</Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
