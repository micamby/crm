import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useSyncExternalStore } from "react";
import { isBusy } from "@/lib/api/problem";

/**
 * "Busy, retrying": a quiet note while some background refresh is being turned away as busy (the
 * server's limit on heavy requests at once, or rate limiting) and what's on screen is the last good
 * copy. Not an error: the refresh is retried (App.tsx) and the note goes when it succeeds.
 */
export function BusyStatus() {
  const qc = useQueryClient();
  const cache = qc.getQueryCache();
  const busy = useSyncExternalStore(
    (cb) => cache.subscribe(cb),
    () => cache.getAll().some((q) => q.state.data !== undefined && isBusy(q.state.error)),
  );
  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed bottom-3 left-3 z-[55]">
      {busy ? (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-sm text-muted shadow-sm">
          <Loader2 aria-hidden className="size-3.5 animate-spin" /> Busy, retrying…
        </span>
      ) : null}
    </div>
  );
}
