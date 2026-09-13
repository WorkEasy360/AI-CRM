import * as React from "react";
import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export const metadata: Metadata = { title: "Choose a new password" };

export default function Page() {
  return (
    <React.Suspense fallback={null}>
      <ResetPasswordForm />
    </React.Suspense>
  );
}
