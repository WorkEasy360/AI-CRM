"use client";

import * as React from "react";
import Link from "next/link";
import { Bell, Menu, Sparkles, X } from "lucide-react";
import { GlobalSearch } from "@/components/shell/global-search";
import { SideNav, Wordmark } from "@/components/shell/nav";
import { OrgSwitcher } from "@/components/shell/org-switcher";
import { QuickAdd } from "@/components/shell/quick-add";
import { UserMenu } from "@/components/shell/user-menu";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import type { ActiveContext, Session } from "@/lib/api/types";
import { cn } from "@/lib/utils";

export function AppShell({ session, active, children }: { session: Session; active: ActiveContext; children: React.ReactNode }) {
  const [navOpen, setNavOpen] = React.useState(false);
  const [copilotOpen, setCopilotOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const { toast } = useToast();

  // Ctrl/⌘+K toggles the global search from anywhere in the app.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const placeholder = (feature: string) => () =>
    toast({ title: `${feature} arrives in a later phase`, description: "This control is a placeholder for now." });

  const mfaBanner = active.mfa_required && !session.mfa_enabled;

  return (
    <div className="flex min-h-dvh">
      {/* Desktop navigation */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface lg:flex">
        <div className="flex h-14 items-center border-b border-border px-5">
          <Wordmark />
        </div>
        <SideNav active={active} />
      </aside>

      {/* Mobile navigation */}
      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="left" className="p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Primary navigation</SheetDescription>
          <div className="flex h-14 items-center border-b border-border px-5">
            <Wordmark />
          </div>
          <SideNav active={active} onNavigate={() => setNavOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface/95 px-3 backdrop-blur sm:px-4">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setNavOpen(true)} aria-label="Open navigation">
            <Menu />
          </Button>
          <OrgSwitcher session={session} />

          <div className="ml-auto flex items-center gap-2">
            <GlobalSearch active={active} open={searchOpen} onOpenChange={setSearchOpen} />
            <QuickAdd active={active} />
            <Button variant="ghost" size="icon" onClick={placeholder("Notifications")} aria-label="Notifications">
              <Bell />
            </Button>
            <Button
              variant={copilotOpen ? "primary" : "ghost"}
              size="icon"
              onClick={() => setCopilotOpen((v) => !v)}
              aria-label="Toggle Copilot"
              aria-pressed={copilotOpen}
            >
              <Sparkles />
            </Button>
            <UserMenu session={session} />
          </div>
        </header>

        {mfaBanner ? (
          <div className="border-b border-warning/40 bg-warning-soft px-4 py-2 text-sm text-fg">
            <span className="font-medium">{active.organization.name}</span> requires two-factor authentication.{" "}
            <Link href="/settings/security" className="font-medium text-primary underline-offset-2 hover:underline">
              Set it up now
            </Link>
            .
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1">
          <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>

          {/* Copilot drawer: inline panel on large screens, sheet below. */}
          <aside
            className={cn(
              "hidden shrink-0 border-l border-border bg-surface transition-[width] xl:block",
              copilotOpen ? "w-80" : "w-0 overflow-hidden border-l-0",
            )}
            aria-label="Copilot"
            aria-hidden={!copilotOpen}
          >
            {copilotOpen ? <CopilotPanel onClose={() => setCopilotOpen(false)} /> : null}
          </aside>
        </div>
      </div>

      <Sheet open={copilotOpen} onOpenChange={setCopilotOpen}>
        <SheetContent side="right" className="p-0 xl:hidden">
          <SheetTitle className="sr-only">Copilot</SheetTitle>
          <SheetDescription className="sr-only">Assistant drawer</SheetDescription>
          <CopilotPanel onClose={() => setCopilotOpen(false)} />
        </SheetContent>
      </Sheet>
    </div>
  );
}

function CopilotPanel({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex h-full w-80 max-w-full flex-col">
      <div className="flex h-14 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2 font-semibold">
          <Sparkles className="size-4 text-accent" /> Copilot
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close Copilot" className="hidden xl:inline-flex">
          <X />
        </Button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Sparkles className="size-6" />
        </div>
        <p className="font-medium">Copilot is coming in Phase 3</p>
        <p className="text-sm text-fg-muted">Ask questions about your pipeline, draft follow-ups and summarise accounts, right here.</p>
      </div>
    </div>
  );
}
