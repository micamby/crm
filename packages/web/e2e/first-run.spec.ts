import { expect, test, type Page } from "@playwright/test";
import { serverCli } from "./env";
import { skipWelcome, watchErrors } from "./helpers";

/**
 * A newcomer's first run on a fresh self-hosted install, as the README describes it: `bootstrap`, then
 * a server-printed link, and no email or single sign-on. Each scenario bootstraps its own workspace, so
 * its owner really is a first owner (no password yet).
 */

function bootstrap(label: string) {
  const stamp = `${label}-${Date.now().toString(36)}`;
  const email = `first-${stamp}@example.com`;
  const out = serverCli(["bootstrap", "--name", `First run ${stamp}`, "--email", email, "--owner-name", "Fiona First"]);
  const workspace = /\((ws_[0-9A-Za-z]+)\)/.exec(out)![1]!;
  return { email, workspace, out };
}

/** Requests the app makes that could only fail when an optional feature is off (the old OAuth discovery probe). */
function watchProbes(page: Page): string[] {
  const probes: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname.startsWith("/.well-known/")) probes.push(r.url());
  });
  return probes;
}

test("the first owner: bootstrap's next steps, sign in by link, the welcome step, set a password, sign in with it", async ({ browser }) => {
  const { email, workspace, out } = bootstrap("owner");
  expect(out).toContain(`docker compose run --rm api sign-in-link --email ${email} --workspace ${workspace}`);
  expect(out).toContain(`hl-crm-db-server sign-in-link --email ${email} --workspace ${workspace}`);
  expect(out).toMatch(/Once signed in, set a password/);

  const context = await browser.newContext();
  const page = await context.newPage();
  watchErrors(page);
  const probes = watchProbes(page);
  await page.goto(serverCli(["sign-in-link", "--email", email, "--workspace", workspace]).trim());
  await page.getByRole("button", { name: /continue/i }).click();
  await page.waitForURL((u) => u.pathname === "/");
  await expect(page.getByRole("heading", { level: 1, name: "Welcome, Fiona" })).toBeVisible();
  const password = ["Amber", "Harbour", "Lantern", Date.now().toString(36)].join("-");
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("New password again").fill(password);
  await page.getByRole("button", { name: "Set password" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Good (morning|afternoon|evening), Fiona/);
  await expect(page.getByText("Password set").first()).toBeVisible();
  // Nothing nags any more: no Home card, no hint in Settings → Account (which also needs no OAuth probe).
  await expect(page.getByRole("region", { name: /set a password/i })).toHaveCount(0);
  await page.goto("/settings/account");
  await expect(page.getByRole("region", { name: "Password" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Password" }).getByRole("note")).toHaveCount(0);
  expect(probes).toEqual([]);
  await context.close();

  // And the password works on its own, in a fresh browser.
  const later = await browser.newContext();
  const again = await later.newPage();
  await again.goto("/sign-in");
  await again.getByRole("textbox", { name: "Email" }).fill(email);
  await again.getByLabel("Password").fill(password);
  await again.getByRole("button", { name: /^sign in$/i }).click();
  await again.waitForURL((u) => u.pathname === "/");
  await expect(again.getByRole("heading", { level: 1 })).toContainText(/Good (morning|afternoon|evening), Fiona/);
  await later.close();
});

test("confirm it's you with no password, email or single sign-on: the command to run, then the action carries on", async ({ browser }) => {
  const { email, workspace } = bootstrap("reauth");
  const context = await browser.newContext();
  const page = await context.newPage();
  watchErrors(page);
  await page.goto(serverCli(["sign-in-link", "--email", email, "--workspace", workspace]).trim());
  await page.getByRole("button", { name: /continue/i }).click();
  await page.waitForURL((u) => u.pathname === "/");
  await skipWelcome(page);
  // The Home card offers a password too, and is dismissed (remembered for the member).
  const card = page.getByRole("region", { name: "Set a password so you can sign in again" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: /dismiss/i }).click();
  await expect(card).toHaveCount(0);

  // Creating a key is answered as it would be 10 minutes after signing in.
  let refused = false;
  await page.route("**/v1/api-keys", async (route) => {
    if (route.request().method() === "POST" && !refused) {
      refused = true;
      await route.fulfill({ status: 403, contentType: "application/problem+json", body: JSON.stringify({ status: 403, code: "recent_sign_in_required", detail: "Sign in again to do this (your last sign-in was more than 10 minutes ago)" }) });
    } else await route.fallback();
  });
  await page.goto("/settings/api-keys");
  await page.getByRole("button", { name: "New key" }).click();
  await page.getByRole("textbox", { name: /^name/i }).fill("E2E first run");
  await page.getByRole("button", { name: "Create key" }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(confirm).toBeVisible();
  // Only what can work: no password box, no "another way"; the command to run instead.
  await expect(confirm.getByLabel("Password")).toHaveCount(0);
  await expect(confirm.getByText(/sign in another way/i)).toHaveCount(0);
  const command = (await confirm.getByTestId("sign-in-link-command").textContent())!.trim();
  expect(command).toBe(`docker compose run --rm api sign-in-link --email ${email} --workspace ${workspace} --return-to /settings/api-keys`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: test.info().outputPath("confirm-no-method.png") });

  // Run it on the "server" (the same command without Docker) and open the link in a new tab of this browser.
  const link = serverCli(command.replace(/^docker compose run --rm api /, "").split(" ")).trim();
  const tab = await context.newPage();
  await tab.goto(link);
  await tab.getByRole("button", { name: /continue/i }).click();
  // It lands where the person was.
  await tab.waitForURL((u) => u.pathname === "/settings/api-keys");
  // Still no password, so that tab offers one first; skipped, it shows the page.
  await tab.getByRole("button", { name: "Skip for now" }).click();
  await expect(tab.getByRole("heading", { level: 2, name: "API keys" })).toBeVisible();
  await tab.close();

  // The first tab notices the new, recent session and the key is created after all.
  await expect(page.getByRole("dialog", { name: /Your new key: E2E first run/ })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("checkbox", { name: /stored it somewhere safe/i }).click();
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("table").getByText("E2E first run")).toBeVisible();
  await context.close();
});
