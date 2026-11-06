"use client";

import * as React from "react";
import Link from "next/link";
import { BookOpen, CircleHelp, Menu, MessageCircle, Search, Settings, Sparkles } from "lucide-react";
import { AskFloatingButton, AssistantProvider, useAssistant } from "@/components/assistant/ask-keel";
import { GlobalSearch } from "@/components/shell/global-search";
import { MobileNav } from "@/components/shell/mobile-nav";
import { SideNav, Wordmark } from "@/components/shell/nav";
import { NotificationsMenu } from "@/components/shell/notifications-menu";
import { QuickAdd } from "@/components/shell/quick-add";
import { QuickCreateProvider } from "@/components/shell/quick-create-provider";
import { UserMenu } from "@/components/shell/user-menu";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import type { ActiveContext, Session } from "@/lib/api/types";
import { workeasy360StartUrl } from "@/lib/auth-methods";
import { hasPermission } from "@/lib/session";
import { setWorkspaceDateFormat } from "@/lib/utils";

export function AppShell({ session, active, children }: { session: Session; active: ActiveContext; children: React.ReactNode }) {
  const [navOpen, setNavOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  // Before the children render, so every formatted date on this render already uses the workspace format.
  setWorkspaceDateFormat(active.organization.date_format);

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

  // Workeasy360 sessions satisfy the requirement only through Workeasy360's own two-step verification.
  const federated = session.identity_provider === "workeasy360";
  const mfaBanner = active.mfa_required && (federated || !session.mfa_enabled);

  return (
    <QuickCreateProvider>
      <AssistantProvider>
      <div className="flex h-dvh overflow-hidden bg-bg">
        {/* Desktop navigation */}
        <aside className="kl-chrome kl-sidebar hidden w-64 shrink-0 flex-col border-r border-border lg:flex">
          <div className="flex h-16 items-center border-b border-border px-5">
            <Wordmark organization={active.organization} />
          </div>
          <SideNav session={session} />
        </aside>

        {/* Full navigation on small screens */}
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetContent side="left" className="kl-chrome kl-sidebar border-r-0 p-0">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SheetDescription className="sr-only">Primary navigation</SheetDescription>
            <div className="flex h-16 items-center border-b border-border px-5">
              <Wordmark organization={active.organization} />
            </div>
            <SideNav session={session} onNavigate={() => setNavOpen(false)} />
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* The top bar shares the sidebar's navy chrome (.kl-chrome re-points the neutral tokens). */}
          <header className="kl-chrome flex h-16 shrink-0 items-center gap-2 border-b border-border bg-chrome px-3 sm:px-6">
            <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={() => setNavOpen(true)} aria-label="Open navigation">
              <Menu />
            </Button>
            <GlobalSearch active={active} open={searchOpen} onOpenChange={setSearchOpen} />

            <div className="ml-auto flex items-center gap-1.5">
              <QuickAdd active={active} />
              {hasPermission(active, "whatsapp.view") ? (
                <Button asChild size="icon-sm" className="bg-[#25D366] text-white hover:bg-[#1ebe5b]" aria-label="WhatsApp inbox">
                  <Link href="/activities?tab=whatsapp">
                    <MessageCircle />
                  </Link>
                </Button>
              ) : null}
              <NotificationsMenu />
              <HelpMenu onSearch={() => setSearchOpen(true)} />
              <UserMenu session={session} />
            </div>
          </header>

          {mfaBanner ? (
            <div className="border-b border-warning/40 bg-warning-soft px-4 py-2 text-sm text-fg sm:px-6">
              <span className="font-medium">{active.organization.name}</span> requires two-factor authentication.{" "}
              {federated ? (
                <>
                  Turn on two-step verification in your Workeasy360 account, then{" "}
                  <a href={workeasy360StartUrl("/pipeline")} className="font-medium text-primary underline-offset-2 hover:underline">
                    sign in again
                  </a>
                </>
              ) : (
                <Link href="/settings/security" className="font-medium text-primary underline-offset-2 hover:underline">
                  Set it up now
                </Link>
              )}
              .
            </div>
          ) : null}

          {/* Bottom padding clears the mobile tab bar; desktop keeps the plain 1rem. */}
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pt-4 pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:px-6 sm:pt-5 lg:pb-6">{children}</main>
        </div>

        <MobileNav active={active} onSearch={() => setSearchOpen(true)} />
        <AskFloatingButton />
      </div>
      </AssistantProvider>
    </QuickCreateProvider>
  );
}

/** The top bar's "?": quick ways in (search, the assistant) and settings, which live in the sidebar too. */
function HelpMenu({ onSearch }: { onSearch: () => void }) {
  const assistant = useAssistant();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Help">
          <CircleHelp />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={onSearch}>
          <Search /> Search everything
          <kbd className="ml-auto text-xs text-fg-subtle">Ctrl K</kbd>
        </DropdownMenuItem>
        {assistant?.available ? (
          <DropdownMenuItem onSelect={() => assistant.openPanel()}>
            <Sparkles /> Ask WorkEasy AI
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem asChild>
          <Link href="/help">
            <BookOpen /> Help Center
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings /> Settings
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
