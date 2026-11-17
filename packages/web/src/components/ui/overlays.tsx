import { AlertDialog as AD, Dialog as D, DropdownMenu as DM, Popover as P, Tooltip as T } from "radix-ui";
import { X } from "lucide-react";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";

// --- Dialog -------------------------------------------------------------------------------------

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

/**
 * A modal dialog with a title (required, for its accessible name), an optional description, a body and
 * a footer. Escape and the close button dismiss it; focus is trapped while it is open and returns to the
 * trigger after.
 */
export function DialogContent({
  title, description, children, footer, className, size = "md", hideClose, onOpenAutoFocus,
}: {
  title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; className?: string;
  size?: "sm" | "md" | "lg" | "xl"; hideClose?: boolean; onOpenAutoFocus?: (e: Event) => void;
}) {
  const width = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" }[size];
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-40 bg-overlay animate-fade-in" />
      <D.Content
        onOpenAutoFocus={onOpenAutoFocus}
        className={cn(
          "fixed left-1/2 top-[8vh] z-50 flex max-h-[84vh] w-[calc(100vw-1.5rem)] -translate-x-1/2 flex-col rounded-lg border border-line bg-surface shadow-lg animate-pop-in",
          width, className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <D.Title className="text-lg font-semibold text-fg">{title}</D.Title>
            {description ? <D.Description className="mt-0.5 text-sm text-muted">{description}</D.Description> : <D.Description className="sr-only">{typeof title === "string" ? title : "Dialog"}</D.Description>}
          </div>
          {hideClose ? null : (
            <D.Close asChild>
              <Button variant="subtle" size="icon-sm" aria-label="Close"><X /></Button>
            </D.Close>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
      </D.Content>
    </D.Portal>
  );
}

// --- Confirm ------------------------------------------------------------------------------------

/** A yes/no question that must be answered (no dismissing by clicking outside). */
export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel, onConfirm, danger, busy, children,
}: {
  open: boolean; onOpenChange: (open: boolean) => void; title: ReactNode; description?: ReactNode; confirmLabel: string;
  onConfirm: () => void; danger?: boolean; busy?: boolean; children?: ReactNode;
}) {
  return (
    <AD.Root open={open} onOpenChange={onOpenChange}>
      <AD.Portal>
        <AD.Overlay className="fixed inset-0 z-40 bg-overlay animate-fade-in" />
        <AD.Content className="fixed left-1/2 top-[18vh] z-50 w-[calc(100vw-1.5rem)] max-w-md -translate-x-1/2 rounded-lg border border-line bg-surface p-5 shadow-lg animate-pop-in">
          <AD.Title className="text-lg font-semibold">{title}</AD.Title>
          {description ? <AD.Description className="mt-1.5 text-base text-muted">{description}</AD.Description> : <AD.Description className="sr-only">Confirm</AD.Description>}
          {children ? <div className="mt-3">{children}</div> : null}
          <div className="mt-5 flex justify-end gap-2">
            <AD.Cancel asChild><Button variant="secondary">Cancel</Button></AD.Cancel>
            <Button variant={danger ? "danger" : "primary"} busy={busy} onClick={onConfirm}>{confirmLabel}</Button>
          </div>
        </AD.Content>
      </AD.Portal>
    </AD.Root>
  );
}

// --- Dropdown menu ------------------------------------------------------------------------------

export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;
export const MenuGroup = DM.Group;
export const MenuRadioGroup = DM.RadioGroup;

export const MenuContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DM.Content>>(function MenuContent({ className, sideOffset = 4, ...props }, ref) {
  return (
    <DM.Portal>
      <DM.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn("z-50 min-w-44 max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto rounded-md border border-line bg-surface p-1 shadow-lg animate-pop-in", className)}
        {...props}
      />
    </DM.Portal>
  );
});

const itemClass =
  "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-base text-fg outline-none " +
  "data-[highlighted]:bg-surface-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-muted";

export const MenuItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DM.Item> & { danger?: boolean }>(function MenuItem({ className, danger, ...props }, ref) {
  return <DM.Item ref={ref} className={cn(itemClass, danger && "text-danger-fg [&_svg]:text-danger-fg", className)} {...props} />;
});

export const MenuCheckboxItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DM.CheckboxItem>>(function MenuCheckboxItem({ className, children, ...props }, ref) {
  return (
    <DM.CheckboxItem ref={ref} className={cn(itemClass, "pl-7", className)} {...props}>
      <DM.ItemIndicator className="absolute left-2 inline-flex"><span aria-hidden className="text-accent">✓</span></DM.ItemIndicator>
      {children}
    </DM.CheckboxItem>
  );
});

export const MenuRadioItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof DM.RadioItem>>(function MenuRadioItem({ className, children, ...props }, ref) {
  return (
    <DM.RadioItem ref={ref} className={cn(itemClass, "pl-7", className)} {...props}>
      <DM.ItemIndicator className="absolute left-2.5 inline-flex"><span aria-hidden className="size-1.5 rounded-full bg-accent" /></DM.ItemIndicator>
      {children}
    </DM.RadioItem>
  );
});

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DM.Label className="px-2 pb-1 pt-1.5 text-xs font-medium uppercase tracking-wide text-subtle">{children}</DM.Label>;
}
export function MenuSeparator() {
  return <DM.Separator className="-mx-1 my-1 h-px bg-line" />;
}

// --- Popover ------------------------------------------------------------------------------------

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverAnchor = P.Anchor;
export const PopoverClose = P.Close;

export const PopoverContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof P.Content>>(function PopoverContent({ className, sideOffset = 4, align = "start", ...props }, ref) {
  return (
    <P.Portal>
      <P.Content
        ref={ref}
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cn("z-50 max-h-[min(80vh,var(--radix-popover-content-available-height))] overflow-y-auto rounded-md border border-line bg-surface p-3 shadow-lg animate-pop-in", className)}
        {...props}
      />
    </P.Portal>
  );
});

// --- Tooltip ------------------------------------------------------------------------------------

export const TooltipProvider = T.Provider;

/** A short label on hover or focus. Not for anything essential: the trigger must have its own accessible name. */
export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={4} className="z-50 max-w-72 rounded-sm bg-fg px-2 py-1 text-sm text-surface shadow-md animate-fade-in">
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
