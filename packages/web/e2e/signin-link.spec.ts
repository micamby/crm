import { expect, test } from "@playwright/test";
import { readState, serverCli } from "./env";
import { skipWelcome } from "./helpers";

/**
 * The server-printed sign-in link, in a real browser: its /auth/link page (Referrer-Policy: no-referrer,
 * so the single-use token never reaches a Referer or document.referrer) and its Continue button, a form
 * post that browsers send with Origin: null and Sec-Fetch-Site: same-origin. Runs in Chromium, Firefox and WebKit.
 */
test("a server-printed sign-in link signs in and lands in the app, without leaking its token", async ({ page, browserName }) => {
  const { workspace, owner } = readState();
  const link = serverCli(["sign-in-link", "--email", owner, "--workspace", workspace]).trim();
  const token = new URL(link).searchParams.get("token")!;
  expect(token.length).toBeGreaterThan(10);
  const requests: { url: string; referer: string | undefined; origin: string | undefined; site: string | undefined; method: string }[] = [];
  page.on("request", (r) => {
    void r.allHeaders().then((h) => requests.push({ url: r.url(), referer: h.referer, origin: h.origin, site: h["sec-fetch-site"], method: r.method() }), () => {});
  });

  const first = await page.goto(link);
  expect(first!.headers()["referrer-policy"]).toBe("no-referrer");
  await page.getByRole("button", { name: /continue/i }).click();
  await page.waitForURL((u) => u.pathname === "/");
  await skipWelcome(page);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Good (morning|afternoon|evening)/);

  // Nothing carried the token in a Referer, and the landing page can't read it either.
  expect(requests.filter((r) => r.referer?.includes(token))).toEqual([]);
  expect(await page.evaluate(() => document.referrer)).not.toContain(token);
  // The Continue post went out as the server now accepts it (recorded per engine, for the report).
  const post = requests.find((r) => r.method === "POST" && new URL(r.url).pathname.startsWith("/auth/"));
  expect(post, browserName).toBeTruthy();
  test.info().annotations.push({ type: "form-post", description: `${browserName}: Origin ${post!.origin ?? "(none)"}, Sec-Fetch-Site ${post!.site ?? "(none)"}` });
  // And the app works: a write from it (a preference) carries the real Origin.
  await page.goto("/settings/account");
  const saved = page.waitForResponse((r) => r.url().endsWith("/v1/me/preferences") && r.request().method() === "PUT");
  await page.getByRole("radio", { name: /dark/i }).click();
  const res = await saved;
  expect(res.status()).toBe(200);
  expect((await res.request().allHeaders()).origin).toBe(new URL(page.url()).origin);
  await page.getByRole("radio", { name: /system/i }).click();
});
