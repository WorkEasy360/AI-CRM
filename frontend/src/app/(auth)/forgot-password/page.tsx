import * as React from "react";
import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export const metadata: Metadata = { title: "Reset password" };

export default function Page() {
  return (
    <React.Suspense fallback={null}>
      <ForgotPasswordForm />
    </React.Suspense>
  );
}
