import * as React from "react";
import Link from "next/link";
import { CsrfBootstrap } from "@/components/auth/csrf-bootstrap";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-bg px-4 py-10">
      <CsrfBootstrap />
      <Link href="/login" className="mb-6 flex items-center gap-2 font-semibold text-fg" aria-label="Keel CRM">
        <span className="flex size-8 items-center justify-center rounded-sm bg-primary text-primary-fg">
          <svg viewBox="0 0 20 20" className="size-4" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M5 3v14M5 10l8-7M5 10l8 7" />
          </svg>
        </span>
        <span className="text-lg tracking-tight">Keel</span>
      </Link>
      <div className="w-full max-w-md rounded-md border border-border bg-surface p-6 shadow-md sm:p-8">{children}</div>
      <p className="mt-6 text-xs text-fg-subtle">Keel CRM · Phase 1</p>
    </div>
  );
}
