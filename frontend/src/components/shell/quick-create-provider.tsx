"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ActivityFormDialog } from "@/components/activities/activity-form-dialog";
import { CompanyFormDialog } from "@/components/crm/companies/company-form-dialog";
import { ContactFormDialog } from "@/components/crm/contacts/contact-form-dialog";
import { DealFormDialog } from "@/components/crm/deals/deal-form-dialog";
import { useToast } from "@/components/ui/toast";
import { listPipelines } from "@/lib/api/crm";
import type { ActivityKind, NamedRef } from "@/lib/api/crm-types";
import { errorMessage } from "@/lib/api/problem";
import { crmKeys } from "@/lib/crm/keys";

export type QuickCreateKind = "contact" | "company" | "deal" | ActivityKind;

/** Records to link a new activity to. Ignored by the contact, company and deal dialogs. */
export interface QuickCreateDefaults {
  contact?: NamedRef | null;
  company?: NamedRef | null;
  deal?: NamedRef | null;
}

export interface QuickCreateContextValue {
  /** Open the create dialog for `kind` from anywhere inside the app shell. */
  open: (kind: QuickCreateKind, defaults?: QuickCreateDefaults) => void;
}

const ACTIVITY_KINDS: readonly QuickCreateKind[] = ["task", "call", "meeting"];

const QuickCreateContext = React.createContext<QuickCreateContextValue>({
  // Outside the shell (tests, isolated stories) opening is a no-op rather than a crash.
  open: () => {},
});

export function useQuickCreate(): QuickCreateContextValue {
  return React.useContext(QuickCreateContext);
}

interface Request {
  kind: QuickCreateKind;
  defaults?: QuickCreateDefaults;
  open: boolean;
}

/**
 * Mounts the create dialogs once for the whole app so "+ New" works on every page. Dialogs are
 * rendered only after their first request (they load custom fields and pipelines on mount) and
 * kept mounted afterwards so closing animates and reopening is instant.
 */
export function QuickCreateProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { toast } = useToast();
  const [request, setRequest] = React.useState<Request | null>(null);
  // Where keyboard focus should land when the dialog closes. Requests usually come from a menu item
  // (quick-add, mobile nav) that unmounts as its menu closes, so the dialog's own focus return would
  // find nothing and drop focus on <body>. Remember the menu's trigger (Radix labels the menu with
  // it) or, failing that, whatever was focused, and restore it if focus was lost.
  const returnFocusRef = React.useRef<HTMLElement | null>(null);

  const open = React.useCallback((kind: QuickCreateKind, defaults?: QuickCreateDefaults) => {
    if (typeof document !== "undefined") {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const triggerId = active?.closest('[role="menu"]')?.getAttribute("aria-labelledby");
      returnFocusRef.current = (triggerId ? document.getElementById(triggerId) : null) ?? active;
    }
    setRequest({ kind, defaults, open: true });
  }, []);
  const value = React.useMemo<QuickCreateContextValue>(() => ({ open }), [open]);

  const close = React.useCallback(() => {
    setRequest((prev) => (prev ? { ...prev, open: false } : prev));
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (!target) return;
    // Runs after the dialog's own focus return; only steps in when that left focus on <body>.
    window.setTimeout(() => {
      if (target.isConnected && (document.activeElement === null || document.activeElement === document.body)) target.focus();
    }, 0);
  }, []);
  const onOpenChange = (next: boolean) => {
    if (!next) close();
  };

  const dealOpen = request?.kind === "deal" && request.open;
  const pipelinesQuery = useQuery({
    queryKey: crmKeys.pipelines,
    queryFn: () => listPipelines(),
    enabled: dealOpen,
    staleTime: 60_000,
  });
  const pipelines = React.useMemo(() => pipelinesQuery.data?.results ?? [], [pipelinesQuery.data]);

  // Without pipelines the deal form cannot pick a stage: explain and close instead of showing an empty select.
  const pipelinesError = dealOpen && pipelinesQuery.isError ? pipelinesQuery.error : null;
  React.useEffect(() => {
    if (!pipelinesError) return;
    toast({ tone: "error", title: "Could not load pipelines", description: errorMessage(pipelinesError) });
    close();
  }, [pipelinesError, toast, close]);

  const isActivity = request ? ACTIVITY_KINDS.includes(request.kind) : false;

  return (
    <QuickCreateContext.Provider value={value}>
      {children}

      {request?.kind === "contact" ? (
        <ContactFormDialog
          open={request.open}
          onOpenChange={onOpenChange}
          onSaved={(saved) => {
            close();
            router.push(`/contacts/${encodeURIComponent(saved.id)}`);
          }}
        />
      ) : null}

      {request?.kind === "company" ? (
        <CompanyFormDialog
          open={request.open}
          onOpenChange={onOpenChange}
          onSaved={(saved) => {
            close();
            router.push(`/companies/${encodeURIComponent(saved.id)}`);
          }}
        />
      ) : null}

      {request?.kind === "deal" ? (
        <DealFormDialog
          // The form re-reads `pipelines` while open, so it may open before they arrive.
          open={request.open}
          onOpenChange={onOpenChange}
          pipelines={pipelines}
          onSaved={(saved) => {
            close();
            router.push(`/deals/${encodeURIComponent(saved.id)}`);
          }}
        />
      ) : null}

      {request && isActivity ? (
        <ActivityFormDialog
          key={request.kind}
          open={request.open}
          onOpenChange={onOpenChange}
          kind={request.kind as ActivityKind}
          defaults={request.defaults}
          onSaved={close}
        />
      ) : null}
    </QuickCreateContext.Provider>
  );
}
