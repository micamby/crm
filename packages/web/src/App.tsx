import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { ReauthDialog } from "./features/shell/Reauth";
import { SessionLostDialog } from "./features/shell/SessionLost";
import { ApiClient } from "./lib/api/client";
import { ApiProvider } from "./lib/api/context";
import { ApiProblem, isBusy } from "./lib/api/problem";
import { BusyStatus } from "./components/BusyStatus";
import { createAppRouter } from "./router";
import { ToastProvider } from "./components/ui/toast";
import { TooltipProvider } from "./components/ui/overlays";

/** Retries only what may succeed on a second try: network failures and server errors, twice. */
function retry(count: number, error: unknown): boolean {
  if (isBusy(error)) return count < 1;
  if (error instanceof ApiProblem && error.status >= 400 && error.status < 500) return false;
  return count < 2;
}

export function App() {
  const [lost, setLost] = useState(false);
  // An action that needs a recent sign-in waits here while the person confirms it's them.
  const [reauth, setReauth] = useState<((confirmed: boolean) => void) | null>(null);
  // One client per app: it holds the session's CSRF token in memory and nothing else.
  const [api] = useState(() => new ApiClient({
    onUnauthenticated: () => setLost(true),
    onRecentSignInRequired: () => new Promise<boolean>((resolve) => setReauth(() => resolve)),
  }));
  const [queryClient] = useState(() => new QueryClient({
    // A background refresh the server turned away as busy (after the request helper's own retries) keeps
    // what's on screen; it is tried again shortly, and the shell says "busy, retrying" meanwhile.
    queryCache: new QueryCache({
      onError: (e, q) => {
        if (!isBusy(e) || q.state.data === undefined) return;
        setTimeout(() => void q.fetch().catch(() => {}), Math.min(30, Math.max(2, (e as ApiProblem).retryAfter ?? 5)) * 1000);
      },
    }),
    defaultOptions: {
      queries: { retry, refetchOnWindowFocus: false, staleTime: 15_000 },
      mutations: { retry: false },
    },
  }));
  const [router] = useState(() => createAppRouter({ api, queryClient }));
  return (
    <ApiProvider value={api}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={400}>
          <ToastProvider>
            <RouterProvider router={router} />
            <SessionLostDialog open={lost} onOpenChange={setLost} />
            <BusyStatus />
            <ReauthDialog open={reauth !== null} onDone={(ok) => {
              reauth?.(ok);
              setReauth(null);
            }} />
          </ToastProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ApiProvider>
  );
}
