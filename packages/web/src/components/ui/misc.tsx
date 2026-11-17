import { Checkbox as CB, Switch as SW, Tabs as TB } from "radix-ui";
import { Check, Minus } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export const Checkbox = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof CB.Root>>(function Checkbox({ className, ...props }, ref) {
  return (
    <CB.Root
      ref={ref}
      className={cn(
        "peer inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-line-strong bg-surface text-accent-fg",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CB.Indicator>{props.checked === "indeterminate" ? <Minus className="size-3" strokeWidth={3} /> : <Check className="size-3" strokeWidth={3} />}</CB.Indicator>
    </CB.Root>
  );
});

export const Switch = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof SW.Root>>(function Switch({ className, ...props }, ref) {
  return (
    <SW.Root
      ref={ref}
      className={cn(
        "inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-line-strong bg-surface-3 transition-colors",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SW.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-surface shadow-sm ring-1 ring-line-strong transition-transform data-[state=checked]:translate-x-[1.1rem] data-[state=checked]:ring-0" />
    </SW.Root>
  );
});

export const Tabs = TB.Root;
export const TabsContent = TB.Content;
export function TabsList({ children, className, label }: { children: ReactNode; className?: string; label: string }) {
  return <TB.List aria-label={label} className={cn("flex gap-1 border-b border-line", className)}>{children}</TB.List>;
}
export function TabsTrigger({ value, children }: { value: string; children: ReactNode }) {
  return (
    <TB.Trigger
      value={value}
      className="-mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent px-2.5 py-1.5 text-base text-muted hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg data-[state=active]:font-medium focus-visible:outline-2 focus-visible:outline-focus"
    >
      {children}
    </TB.Trigger>
  );
}

type Tone = "neutral" | "accent" | "danger" | "warning" | "success" | "info";
const TONES: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted border-line",
  accent: "bg-accent-soft text-accent-soft-fg border-transparent",
  danger: "bg-danger-soft text-danger-fg border-transparent",
  warning: "bg-warning-soft text-warning-fg border-transparent",
  success: "bg-success-soft text-success-fg border-transparent",
  info: "bg-info-soft text-info-fg border-transparent",
};

export function Badge({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex max-w-full items-center gap-1 truncate rounded-sm border px-1.5 py-px text-sm font-medium leading-4", TONES[tone], className)}>
      {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("skeleton block h-3.5", className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-line bg-surface-2 px-1 font-sans text-xs text-muted">{children}</kbd>;
}

export function Separator({ className }: { className?: string }) {
  return <div role="separator" className={cn("h-px bg-line", className)} />;
}
