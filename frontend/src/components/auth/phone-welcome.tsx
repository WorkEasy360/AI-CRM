"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { LogIn, UserPlus } from "lucide-react";
import { BrandLogo } from "@/components/shell/nav";
import { Button } from "@/components/ui/button";

/** Rising bars and an arrow on the hero. Decoration only. */
function GrowthArt() {
  const bars = [
    { x: 14, height: 34 },
    { x: 62, height: 62 },
    { x: 110, height: 88 },
    { x: 158, height: 122 },
  ];
  return (
    <svg viewBox="0 0 220 170" className="mx-auto h-auto w-full max-w-56" aria-hidden>
      <defs>
        <linearGradient id="kl-welcome-bar" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3ddc97" />
          <stop offset="1" stopColor="#0c7a54" />
        </linearGradient>
      </defs>
      {bars.map((bar) => (
        <rect key={bar.x} x={bar.x} y={165 - bar.height} width="34" height={bar.height} rx="4" fill="url(#kl-welcome-bar)" />
      ))}
      <path d="M4 112 58 72l34 20 62-58" fill="none" stroke="#3ddc97" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M176 8l-30 12 20 20Z" fill="#3ddc97" />
    </svg>
  );
}

/**
 * The app's first screen on a phone: the brand, then Login or Create Account. It lies over the sign-in
 * form and switches with CSS, so a phone never sees the form flash first and larger screens never see
 * this. A page reached with a message for the form (a failed sign-in, say) goes straight to it.
 */
export function PhoneWelcome() {
  const params = useSearchParams();
  const [dismissed, setDismissed] = React.useState(false);
  const onlyNext = [...params.keys()].every((key) => key === "next");
  if (dismissed || !onlyNext) return null;

  return (
    <section aria-label="Welcome to WorkEasy360 CRM" className="kl-phone-hero fixed inset-0 z-40 flex flex-col overflow-y-auto text-white md:hidden">
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 pt-8 pb-4 text-center">
        <BrandLogo size={56} className="rounded-xl bg-white/95 p-1" />
        <p className="text-3xl font-bold tracking-tight">
          WorkEasy<span className="text-[#3ddc97]">360</span>
        </p>
        <span className="rounded-md bg-brand-bright px-3 py-0.5 text-xl font-bold text-[#06291f]">CRM</span>
        <h2 className="mt-2 text-2xl leading-tight font-bold">
          Simple CRM for
          <br />
          Small Businesses
        </h2>
        <p className="max-w-72 text-md text-white/85">Manage leads, deals, follow-ups and grow your sales.</p>
        <div className="mt-2 w-full">
          <GrowthArt />
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-t-2xl bg-surface px-6 pt-6 pb-[calc(1.25rem+env(safe-area-inset-bottom))] text-center text-fg">
        <Button size="lg" className="h-12 w-full" onClick={() => setDismissed(true)}>
          <LogIn /> Login to CRM
        </Button>
        <Button asChild size="lg" variant="secondary" className="h-12 w-full border-brand text-brand">
          <Link href="/signup">
            <UserPlus /> Create Account
          </Link>
        </Button>
        <p className="mt-2 text-sm font-semibold">Part of WorkEasy360 Ecosystem</p>
        <p className="text-sm text-brand">CRM | HR | Books | Operations | and More</p>
      </div>
    </section>
  );
}
