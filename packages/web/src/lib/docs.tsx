import type { ReactNode } from "react";

/**
 * Where the documentation lives, from one place: this repository's docs on GitHub, unless the build
 * sets VITE_DOCS_URL (a fork pointing at its own copy, or a docs site). Every link to the docs in
 * the app goes through docsUrl or DocsLink.
 */
const DEFAULT_DOCS_URL = "https://github.com/open-gtm/crm/blob/main/docs";
const configured = (import.meta.env.VITE_DOCS_URL as string | undefined)?.trim().replace(/\/+$/, "");
export const DOCS_URL = configured && /^https:\/\//.test(configured) ? configured : DEFAULT_DOCS_URL;

/** The address of one page of the docs, by its path under docs/ (e.g. "automations.md"). */
export const docsUrl = (page: string) => `${DOCS_URL}/${page.replace(/^\/+/, "")}`;

/** A link to a page of the docs, opening in a new tab. */
export function DocsLink({ page, children }: { page: string; children: ReactNode }) {
  return <a className="font-medium text-accent underline" href={docsUrl(page)} target="_blank" rel="noreferrer">{children}</a>;
}
