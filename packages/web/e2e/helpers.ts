import { expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readState, serverCli } from "./env";

const SHOTS = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "screenshots");

/**
 * Signs in through a server-printed sign-in link: its page, then its Continue button (a form post).
 * A member without a password first sees the welcome step offering to set one; this skips it.
 */
export async function signIn(page: Page, email: string, workspace = readState().workspace) {
  const link = serverCli(["sign-in-link", "--email", email, "--workspace", workspace]).trim();
  await page.goto(link);
  await page.getByRole("button", { name: /continue/i }).click();
  await page.waitForURL((u) => u.pathname === "/");
  await skipWelcome(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Good (morning|afternoon|evening)/);
}

/** Skips the welcome step if it is showing (a member signed in by link with no password yet). */
export async function skipWelcome(page: Page) {
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toContainText(/Good (morning|afternoon|evening)|Welcome/);
  if (/Welcome/.test((await heading.textContent()) ?? "")) await page.getByRole("button", { name: "Skip for now" }).click();
}

/**
 * The committed screenshots in docs/screenshots are refreshed only on request (`pnpm screenshots`, which
 * sets E2E_SCREENSHOTS=1); an ordinary test run leaves them alone.
 */
export const SHOOTING = process.env.E2E_SCREENSHOTS === "1";

export async function shot(page: Page, name: string) {
  if (!SHOOTING) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Fails on a Content-Security-Policy violation or an uncaught error in the page. */
export function watchErrors(page: Page) {
  page.on("pageerror", (e) => { throw e; });
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused to/.test(m.text())) throw new Error(m.text());
  });
}
