import * as React from "react";
import Link from "next/link";
import { BarChart3, CalendarCheck, KanbanSquare, Users } from "lucide-react";
import { AuthProductPreview } from "@/components/auth/auth-product-preview";
import { CsrfBootstrap } from "@/components/auth/csrf-bootstrap";
import { BrandLogo } from "@/components/shell/nav";

const FEATURES = [
  { icon: Users, title: "Lead Management", text: "Capture, track and convert leads" },
  { icon: KanbanSquare, title: "Sales Pipeline", text: "Manage deals across stages" },
  { icon: CalendarCheck, title: "Tasks & Follow-ups", text: "Stay on top of every opportunity" },
  { icon: BarChart3, title: "Business Insights", text: "Track leads, deals and conversions" },
] as const;

/**
 * Sign-in, sign-up and account recovery: the navy brand panel on large screens (the same chrome as
 * the app's sidebar), the form on a white card beside it. Small screens show the card alone.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh bg-bg">
      <CsrfBootstrap />
      <aside className="kl-chrome kl-sidebar relative hidden min-w-0 flex-[1.4] flex-col overflow-hidden p-8 lg:flex xl:p-12">
        {/* The waves are the brand green over the navy chrome: decoration only, drawn from the tokens. */}
        <svg className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 900 900" preserveAspectRatio="xMidYMid slice" aria-hidden>
          <path d="M520 0C640 120 760 170 900 150V0Z" fill="var(--kl-brand-bright)" opacity="0.1" />
          <path d="M660 0C730 70 820 100 900 90V0Z" fill="var(--kl-brand-bright)" opacity="0.18" />
          <path d="M0 780C170 700 340 860 520 850S800 720 900 760V900H0Z" fill="var(--kl-brand-bright)" opacity="0.12" />
          <path d="M0 840C190 780 350 900 560 890S820 810 900 830V900H0Z" fill="var(--kl-brand-bright)" opacity="0.2" />
        </svg>

        <div className="relative flex min-h-0 flex-1 flex-col">
          <Link href="/login" className="flex w-fit items-center gap-2.5 font-semibold text-fg" aria-label="WorkEasy360">
            <BrandLogo size={44} />
            <span className="text-3xl tracking-tight">
              WorkEasy<span className="text-chrome-indicator">360</span>
            </span>
          </Link>

          <span className="mt-8 inline-flex w-fit items-center gap-2 rounded-lg bg-brand px-4 py-1.5 text-lg font-semibold text-brand-fg">
            <Users className="size-5" aria-hidden /> CRM
          </span>
          <p className="mt-4 text-5xl font-bold leading-tight tracking-tight text-fg">
            WorkEasy <span className="text-chrome-indicator">CRM</span>
          </p>
          <p className="mt-1 text-2xl font-bold tracking-tight text-fg">Simple CRM for Small Businesses</p>
          <p className="mt-3 max-w-lg text-md text-fg-muted">Manage leads, deals, follow-ups and your sales pipeline from one easy platform.</p>

          <div className="mt-8 flex min-h-0 flex-1 items-center gap-6 xl:gap-8">
            <ul className="flex shrink-0 flex-col gap-5">
              {FEATURES.map((feature) => (
                <li key={feature.title} className="flex items-center gap-3.5">
                  <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-fg" aria-hidden>
                    <feature.icon className="size-6" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-md font-semibold text-fg">{feature.title}</span>
                    <span className="block text-sm text-fg-muted">{feature.text}</span>
                  </span>
                </li>
              ))}
            </ul>
            <AuthProductPreview className="hidden min-w-0 flex-1 xl:block" />
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col items-center justify-center px-4 py-8 sm:py-10">
        <div className="w-full max-w-lg rounded-lg border border-border bg-surface p-6 shadow-md sm:p-8">{children}</div>
      </main>
    </div>
  );
}
