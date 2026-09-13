"use client";

import * as React from "react";
import Link from "next/link";
import { Menu, Settings } from "lucide-react";
import { GlobalSearch } from "@/components/shell/global-search";
import { MobileNav } from "@/components/shell/mobile-nav";
import { SideNav, Wordmark } from "@/components/shell/nav";
import { NotificationsMenu } from "@/components/shell/notifications-menu";
import { QuickAdd } from "@/components/shell/quick-add";
import { QuickCreateProvider } from "@/components/shell/quick-create-provider";
import { UserMenu } from "@/components/shell/user-menu";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import type { ActiveContext, Session } from "@/lib/api/types";

export function AppShell({ session, active, children }: { session: Session; active: ActiveContext; children: React.ReactNode }) {
  const [navOpen, setNavOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);

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

  const mfaBanner = active.mfa_required && !session.mfa_enabled;

  return (
    <QuickCreateProvider>
      <div className="flex h-dvh overflow-hidden bg-bg">
        {/* Desktop navigation */}
        <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-surface lg:flex">
          <div className="flex h-12 items-center border-b border-border px-4">
            <Wordmark />
          </div>
          <SideNav session={session} />
        </aside>

        {/* Full navigation on small screens */}
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetContent side="left" className="p-0">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SheetDescription className="sr-only">Primary navigation</SheetDescription>
            <div className="flex h-12 items-center border-b border-border px-4">
              <Wordmark />
            </div>
            <SideNav session={session} onNavigate={() => setNavOpen(false)} />
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border bg-surface px-3">
            <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setNavOpen(true)} aria-label="Open navigation">
              <Menu />
            </Button>
            <GlobalSearch active={active} open={searchOpen} onOpenChange={setSearchOpen} />

            <div className="ml-auto flex items-center gap-1">
              <QuickAdd active={active} />
              <NotificationsMenu />
              <Button asChild variant="ghost" size="icon-sm" aria-label="Settings">
                <Link href="/settings">
                  <Settings />
                </Link>
              </Button>
              <UserMenu session={session} />
            </div>
          </header>

          {mfaBanner ? (
            <div className="border-b border-warning/40 bg-warning-soft px-4 py-1.5 text-xs text-fg">
              <span className="font-medium">{active.organization.name}</span> requires two-factor authentication.{" "}
              <Link href="/settings/security" className="font-medium text-primary underline-offset-2 hover:underline">
                Set it up now
              </Link>
              .
            </div>
          ) : null}

          {/* Bottom padding clears the mobile tab bar; desktop keeps the plain 1rem. */}
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pt-4 pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:px-5 lg:pb-4">{children}</main>
        </div>

        <MobileNav active={active} onSearch={() => setSearchOpen(true)} />
      </div>
    </QuickCreateProvider>
  );
}
