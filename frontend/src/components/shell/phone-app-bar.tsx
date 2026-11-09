"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft, Menu, Plus } from "lucide-react";
import { BrandLogo, Wordmark } from "@/components/shell/nav";
import { NotificationsMenu } from "@/components/shell/notifications-menu";
import { permittedQuickAddItems } from "@/components/shell/quick-add";
import { useQuickCreate, type QuickCreateKind } from "@/components/shell/quick-create-provider";
import { Button } from "@/components/ui/button";
import type { ActiveContext } from "@/lib/api/types";

/** The bottom tabs that carry their own title, and what their "+" creates. */
const SCREENS: Record<string, { title: string; create: QuickCreateKind }> = {
  "/pipeline": { title: "Pipeline", create: "deal" },
  "/contacts": { title: "Leads", create: "contact" },
  "/activities": { title: "Tasks & Follow-ups", create: "task" },
};

function PhoneBrand({ active }: { active: ActiveContext }) {
  if (active.organization.crm_name?.trim() || active.organization.logo_url) return <Wordmark organization={active.organization} />;
  return (
    <Link href="/dashboard" className="flex min-w-0 items-center gap-2 font-semibold text-fg" aria-label="WorkEasy360 CRM home">
      <BrandLogo size={28} />
      <span className="truncate text-lg tracking-tight">
        WorkEasy<span className="text-chrome-indicator">360</span> CRM
      </span>
    </Link>
  );
}

/**
 * The phone's top bar. Home shows the menu, the brand and notifications; a tab shows its title with
 * a way back and its "+"; any other page keeps the brand and goes back to where it was opened from.
 */
export function PhoneAppBar({ active, onMenu }: { active: ActiveContext; onMenu: () => void }) {
  const pathname = usePathname() || "";
  const router = useRouter();
  const { open } = useQuickCreate();
  const screen = SCREENS[pathname];
  const canCreate = screen ? permittedQuickAddItems(active, [screen.create]).length > 0 : false;
  const icon = "size-11 text-fg [&_svg]:size-6";

  return (
    <header className="kl-chrome kl-phone-bar flex h-14 shrink-0 items-center gap-1 px-1.5">
      {pathname === "/dashboard" ? (
        <Button variant="ghost" size="icon" className={icon} onClick={onMenu} aria-label="Open navigation">
          <Menu />
        </Button>
      ) : screen ? (
        <Button asChild variant="ghost" size="icon" className={icon}>
          <Link href="/dashboard" aria-label="Back to Home">
            <ArrowLeft />
          </Link>
        </Button>
      ) : (
        <Button variant="ghost" size="icon" className={icon} onClick={() => router.back()} aria-label="Back">
          <ArrowLeft />
        </Button>
      )}

      <div className="min-w-0 flex-1 pl-1">{screen ? <p className="truncate text-lg font-bold tracking-tight text-fg">{screen.title}</p> : <PhoneBrand active={active} />}</div>

      {screen ? (
        canCreate ? (
          <Button variant="ghost" size="icon" className={icon} onClick={() => open(screen.create)} aria-label={`New ${screen.create}`}>
            <Plus />
          </Button>
        ) : null
      ) : (
        <NotificationsMenu />
      )}
    </header>
  );
}
