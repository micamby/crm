import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const control =
  "w-full rounded-md border border-line-strong bg-surface px-2.5 text-base text-fg placeholder:text-subtle shadow-sm " +
  "focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus focus-visible:border-transparent " +
  "disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted aria-invalid:border-danger";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(control, "h-8", className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn(control, "min-h-20 py-1.5 leading-5", className)} {...props} />;
});

/** A native select: accessible, keyboard- and touch-friendly everywhere, and styled to match. */
export const NativeSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function NativeSelect({ className, children, ...props }, ref) {
  return (
    <select ref={ref} className={cn(control, "h-8 appearance-auto pr-1", className)} {...props}>
      {children}
    </select>
  );
});

export function Label({ htmlFor, children, className, required }: { htmlFor?: string; children: ReactNode; className?: string; required?: boolean }) {
  return (
    <label htmlFor={htmlFor} className={cn("text-sm font-medium text-muted", className)}>
      {children}
      {required ? <span className="text-danger" aria-hidden> *</span> : null}
    </label>
  );
}

/**
 * A labelled form field: label, control, hint and error, wired with ids so the control is named and
 * described for assistive tech. `children` receives the props to spread on the control.
 */
export function FormField({
  label, hint, error, required, children, className, labelSuffix,
}: {
  label: ReactNode; hint?: ReactNode; error?: string | null; required?: boolean; className?: string; labelSuffix?: ReactNode;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean; "aria-required"?: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} required={required}>{label}</Label>
        {labelSuffix}
      </div>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined, "aria-required": required || undefined })}
      {error ? <p id={errorId} className="text-sm text-danger-fg" role="alert">{error}</p> : null}
      {hint && !error ? <p id={hintId} className="text-sm text-subtle">{hint}</p> : null}
    </div>
  );
}
