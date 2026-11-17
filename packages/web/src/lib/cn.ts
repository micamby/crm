import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** Knows the app's own type scale (tokens.css), so `text-md` is a size and `text-muted` a colour. */
const merge = extendTailwindMerge({ extend: { theme: { text: ["xs", "sm", "base", "md", "lg", "xl", "2xl"] } } });

/** Joins class names, letting later Tailwind utilities override earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
