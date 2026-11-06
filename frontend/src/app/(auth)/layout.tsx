import * as React from "react";
import Link from "next/link";
import { CsrfBootstrap } from "@/components/auth/csrf-bootstrap";
import { BrandLogo } from "@/components/shell/nav";

/**
 * Sign-in, sign-up and account recovery: the navy brand panel on large screens (the same chrome as
 * the app's sidebar), the form on a white card beside it. Small screens show the card alone.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh bg-bg">
      <CsrfBootstrap />
      <aside className="kl-chrome kl-sidebar hidden w-[42%] max-w-xl flex-col justify-between p-10 lg:flex">
        <Link href="/login" className="flex items-center gap-2.5 font-semibold text-fg" aria-label="WorkEasy CRM">
          <BrandLogo size={36} />
          <span className="text-lg tracking-tight">WorkEasy</span>
          <span className="rounded-sm bg-chrome-indicator px-1.5 py-px text-xs font-bold leading-4 text-chrome">CRM</span>
        </Link>
        <div>
          <p className="text-3xl font-bold leading-tight tracking-tight text-fg">Pipeline, contacts, activities and support in one workspace.</p>
          <p className="mt-3 text-md text-fg-muted">With WorkEasy AI built in.</p>
        </div>
        <p className="text-sm text-fg-muted">© WorkEasy CRM</p>
      </aside>

      <main className="flex flex-1 flex-col items-center justify-center px-4 py-10">
        <Link href="/login" className="mb-6 flex items-center gap-2 font-semibold text-fg lg:hidden" aria-label="WorkEasy CRM">
          <BrandLogo size={36} />
          <span className="text-lg tracking-tight">WorkEasy CRM</span>
        </Link>
        <div className="w-full max-w-md rounded-lg border border-border bg-surface p-6 shadow-md sm:p-8">{children}</div>
      </main>
    </div>
  );
}
