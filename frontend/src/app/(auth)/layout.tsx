import * as React from "react";
import Link from "next/link";
import { CsrfBootstrap } from "@/components/auth/csrf-bootstrap";
import { BrandLogo } from "@/components/shell/nav";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-bg px-4 py-10">
      <CsrfBootstrap />
      <Link href="/login" className="mb-6 flex items-center gap-2 font-semibold text-fg" aria-label="WorkEasy CRM">
        <BrandLogo size={36} />
        <span className="text-lg tracking-tight">WorkEasy CRM</span>
      </Link>
      <div className="w-full max-w-sm rounded-md border border-border bg-surface p-6 shadow-md sm:p-7">{children}</div>
    </div>
  );
}
