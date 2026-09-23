import * as React from "react";
import { headers } from "next/headers";
import { AppFrame } from "@/components/shell/app-frame";
import { SESSION_PRELOAD_SCRIPT } from "@/lib/session-preload";

/**
 * A Server Component so the session request can start while the HTML is still parsing rather than
 * after hydration; everything the group renders lives in <AppFrame>. The nonce is the one the
 * middleware minted for this response, which is what lets the script run under
 * `script-src 'nonce-…' 'strict-dynamic'`.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <>
      {/*
        react/no-danger guards against rendering user-controlled HTML. SESSION_PRELOAD_SCRIPT is a
        module-level string constant with no interpolation and nothing from the request in it, so
        there is no input here to sanitize; only the nonce varies, and it is an attribute.

        suppressHydrationWarning: browsers clear a script's `nonce` content attribute once the
        document is parsed, so the client reads back "" where the server rendered the real value and
        React reports a mismatch. The attribute has already done its job by then - the script ran
        during parsing - and re-rendering it never re-executes it.
      */}
      {/* eslint-disable-next-line react/no-danger */}
      <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: SESSION_PRELOAD_SCRIPT }} />
      <AppFrame>{children}</AppFrame>
    </>
  );
}
