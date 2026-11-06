"use client";

import * as React from "react";
import "@/lib/zod-config";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { reportPlanBoundary, UpgradePromptHost } from "@/components/billing/upgrade-prompt";
import { ReauthProvider } from "@/components/reauth-provider";
import { ThemeSync } from "@/lib/theme";
import { ToastProvider } from "@/components/ui/toast";
import { isApiError } from "@/lib/api/problem";

function makeQueryClient(): QueryClient {
  return new QueryClient({
    // A plan limit or a feature outside the plan opens the upgrade prompt, wherever the request came from.
    mutationCache: new MutationCache({ onError: reportPlanBoundary }),
    queryCache: new QueryCache({ onError: reportPlanBoundary }),
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
        <UpgradePromptHost />
      </ToastProvider>
    </QueryClientProvider>
  );
}
