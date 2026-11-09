import * as React from "react";
import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/login-form";
import { PhoneWelcome } from "@/components/auth/phone-welcome";

export const metadata: Metadata = { title: "Sign in" };

export default function Page() {
  return (
    <React.Suspense fallback={null}>
      <PhoneWelcome />
      <LoginForm />
    </React.Suspense>
  );
}
