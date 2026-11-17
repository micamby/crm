import { AlertTriangle, Check, Copy, Lock, RotateCw, SearchX, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { asProblem } from "@/lib/api/problem";
import { cn } from "@/lib/cn";
import { reauthHref } from "@/lib/session";
import { Button } from "./ui/button";

/** Copies text to the clipboard; says so for a moment. */
export function CopyButton({ text, label = "Copy", className, size = "sm" }: { text: string; label?: string; className?: string; size?: "sm" | "icon-sm" }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <Button
      size={size}
      variant="secondary"
      className={className}
      aria-label={size === "icon-sm" ? label : undefined}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          timer.current = setTimeout(() => setDone(false), 1600);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? <Check /> : <Copy />}
      {size === "icon-sm" ? null : done ? "Copied" : label}
      <span className="sr-only" aria-live="polite">{done ? "Copied to clipboard" : ""}</span>
    </Button>
  );
}

/**
 * An API failure, shown where the content would have been: what went wrong in plain words, the
 * server's detail, and the request ID to quote in a report.
 */
export function ProblemView({ error, onRetry, className, compact }: { error: unknown; onRetry?: () => void; className?: string; compact?: boolean }) {
  const p = asProblem(error);
  const forbidden = p.status === 403;
  const missing = p.status === 404;
  const Icon = forbidden ? Lock : missing ? SearchX : AlertTriangle;
  return (
    <div role="alert" className={cn("flex gap-3 rounded-md border border-line bg-surface p-4", compact ? "p-3" : "", className)}>
      <Icon aria-hidden className={cn("mt-0.5 size-5 shrink-0", forbidden || missing ? "text-muted" : "text-danger")} />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-fg">{p.title}</p>
        <p className="mt-0.5 break-words text-base text-muted">{p.detail}</p>
        {p.requestId ? (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-subtle">
            <span>Request ID <code className="font-mono">{p.requestId}</code></span>
            <CopyButton text={p.requestId} label="Copy request ID" size="icon-sm" />
          </p>
        ) : null}
        {p.code === "recent_sign_in_required" ? (
          <Button size="sm" variant="primary" className="mt-3" onClick={() => window.location.assign(reauthHref())}><ShieldCheck /> Confirm it's you</Button>
        ) : onRetry && !forbidden && !missing ? (
          <Button size="sm" className="mt-3" onClick={onRetry}><RotateCw /> Try again</Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A failed action's message inside a form or dialog: the problem's words, and when the action needs a
 * fresh sign-in, a way to confirm it's you and come back. Plain strings (the app's own checks) work too.
 */
export function ProblemAlert({ error, className }: { error: unknown; className?: string }) {
  if (error === null || error === undefined || error === "") return null;
  const p = typeof error === "string" ? null : asProblem(error);
  return (
    <p role="alert" className={cn("rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-base text-danger-fg", className)}>
      {p ? p.detail : String(error)}
      {p?.code === "recent_sign_in_required" ? <> <a className="font-medium underline" href={reauthHref()}>Confirm it's you</a>, then try once more.</> : null}
    </p>
  );
}

/** The one thing shown when the member's role doesn't reach a page: plainly said, nothing to click that would fail. */
export function NoAccess({ title = "You don't have access to this", children, className }: { title?: string; children?: ReactNode; className?: string }) {
  return (
    <EmptyState icon={<Lock />} title={title} className={className}>
      {children ?? "Your role doesn't include this part of the workspace. If you need it, ask a workspace admin."}
    </EmptyState>
  );
}

export function EmptyState({ icon, title, children, action, className, heading }: {
  icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; className?: string; heading?: "h1" | "h2";
}) {
  const Title = heading ?? "p";
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 px-6 py-12 text-center", className)}>
      {icon ? <div aria-hidden className="mb-1 rounded-full bg-surface-2 p-3 text-muted [&_svg]:size-5">{icon}</div> : null}
      <Title className="text-md font-medium">{title}</Title>
      {children ? <div className="max-w-md text-base text-muted">{children}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/**
 * A page's title row. On a narrow screen a long title truncates (its full text in a tooltip) and the
 * actions wrap below it rather than being pushed off-screen; an action's own label truncates too.
 */
export function PageHeader({ title, subtitle, actions, icon, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; icon?: ReactNode; children?: ReactNode }) {
  return (
    <div className="border-b border-line bg-surface px-4 py-3 md:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-[1_1_12rem] items-center gap-3">
          {icon ? <div aria-hidden className="shrink-0 rounded-md bg-accent-soft p-1.5 text-accent-soft-fg [&_svg]:size-4">{icon}</div> : null}
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-semibold leading-7" title={typeof title === "string" ? title : undefined}>{title}</h1>
            {subtitle ? <div className="text-sm text-muted">{subtitle}</div> : null}
          </div>
        </div>
        {actions ? <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 [&>*]:min-w-0 [&>*]:max-w-full">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}
