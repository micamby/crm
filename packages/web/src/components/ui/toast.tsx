import { Toast as T } from "radix-ui";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { asProblem } from "@/lib/api/problem";
import { cn } from "@/lib/cn";
import { reauthHref } from "@/lib/session";

export interface ToastInput {
  title: string;
  description?: string;
  tone?: "success" | "error" | "info";
  requestId?: string | null;
  action?: { label: string; onClick: () => void };
}
interface ToastItem extends ToastInput { id: number; open: boolean }

interface ToastApi {
  toast: (t: ToastInput) => void;
  /** Shows an API failure: its title, detail and request ID. */
  error: (e: unknown, fallbackTitle?: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast outside ToastProvider");
  return v;
}

/** Toasts announced politely to screen readers (errors assertively), dismissable with Escape or the close button. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const toast = useCallback((t: ToastInput) => {
    setItems((xs) => [...xs.slice(-3), { ...t, id: Date.now() + Math.random(), open: true }]);
  }, []);
  const error = useCallback((e: unknown, fallbackTitle?: string) => {
    const p = asProblem(e);
    toast({ tone: "error", title: fallbackTitle ?? p.title, description: p.detail, requestId: p.requestId,
      ...(p.code === "recent_sign_in_required" ? { action: { label: "Confirm it's you", onClick: () => window.location.assign(reauthHref()) } } : {}) });
  }, [toast]);
  const api = useMemo(() => ({ toast, error }), [toast, error]);
  const close = (id: number) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, open: false } : x)));
  return (
    <Ctx.Provider value={api}>
      <T.Provider swipeDirection="right" duration={6000}>
        {children}
        {items.map((t) => {
          const Icon = t.tone === "error" ? AlertTriangle : t.tone === "success" ? CheckCircle2 : Info;
          return (
            <T.Root
              key={t.id}
              open={t.open}
              type={t.tone === "error" ? "foreground" : "background"}
              duration={t.tone === "error" ? 10_000 : 5000}
              onOpenChange={(o) => {
                if (!o) {
                  close(t.id);
                  setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 300);
                }
              }}
              className={cn("flex w-full items-start gap-2.5 rounded-md border bg-surface p-3 shadow-lg animate-pop-in",
                t.tone === "error" ? "border-danger/40" : "border-line")}
            >
              <Icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", t.tone === "error" ? "text-danger" : t.tone === "success" ? "text-success" : "text-info")} />
              <div className="min-w-0 flex-1">
                <T.Title className="text-base font-medium">{t.title}</T.Title>
                {t.description ? <T.Description className="mt-0.5 break-words text-sm text-muted">{t.description}</T.Description> : null}
                {t.requestId ? <p className="mt-1 font-mono text-xs text-subtle">Request ID {t.requestId}</p> : null}
                {t.action ? (
                  <T.Action asChild altText={t.action.label}>
                    <button type="button" onClick={t.action.onClick} className="mt-1.5 text-sm font-medium text-accent hover:underline">{t.action.label}</button>
                  </T.Action>
                ) : null}
              </div>
              <T.Close aria-label="Dismiss" className="rounded-sm p-0.5 text-subtle hover:bg-surface-2 hover:text-fg"><X className="size-3.5" /></T.Close>
            </T.Root>
          );
        })}
        <T.Viewport className="fixed bottom-3 right-3 z-[60] flex w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-2 outline-none" />
      </T.Provider>
    </Ctx.Provider>
  );
}
