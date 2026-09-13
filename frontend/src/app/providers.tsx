"use client";

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReauthProvider } from "@/components/reauth-provider";
import { ThemeSync } from "@/lib/theme";
import { ToastProvider } from "@/components/ui/toast";
import { isApiError } from "@/lib/api/problem";

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: false,
        retry: (count, error) => {
          // Never retry auth/permission/validation failures.
          if (isApiError(error) && error.status < 500) return false;
          return count < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(makeQueryClient);
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ThemeSync />
        <ReauthProvider>{children}</ReauthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
