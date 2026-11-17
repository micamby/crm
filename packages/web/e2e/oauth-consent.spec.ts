import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test, type Browser } from "@playwright/test";
import { MCP_ORIGIN, ORIGIN, readState, serverCli } from "./env";

/**
 * OAuth for MCP in a real browser: an MCP client (registered here, with a loopback redirect the test
 * intercepts) sends a signed-out browser to /oauth/authorize. The server sends it to sign in and back,
 * the member approves on the consent page, and the browser lands at the client's redirect URI with a
 * code and the state. The consent page is no-referrer, so its decision is a form post with Origin: null
 * and Sec-Fetch-Site: same-origin, which the server accepts for its own HTML forms only; nothing (code,
 * state, the request's URL) travels in a Referer. Runs in Chromium, Firefox and WebKit.
 *
 * Also: the app's own sign-in screen (/sign-in) keeps an OAuth return path and leaves with a full page
 * load, in the re-authentication mode (reauth=1) too, as an admin connection needs a recent sign-in.
 */

/** Registered once; a loopback redirect URI matches on any port (RFC 8252 §7.3), so each test listens on its own. */
const REGISTERED = "http://localhost:51234/callback";
const PASSWORD = `Pw-${randomBytes(12).toString("base64url")}-e2e`;

const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

async function registerClient(name: string): Promise<string> {
  const r = await fetch(`${ORIGIN}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [REGISTERED], application_type: "native", grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" }) });
  const json = await r.json() as { client_id: string };
  expect(r.status, JSON.stringify(json)).toBe(201);
  return json.client_id;
}

function authorizePath(clientId: string, redirect: string, resource: "ops" | "admin", state: string, verifier: string): string {
  return `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, scope: resource === "admin" ? "admin" : "ops:read ops:write",
    resource: `${MCP_ORIGIN}/mcp/${resource}`, state, code_challenge: s256(verifier), code_challenge_method: "S256" })}`;
}

/** An admin member of the E2E workspace with a password, signed in once through a server-printed link to set it. */
async function adminWithPassword(browser: Browser, engine: string): Promise<string> {
  const { workspace, adminKey } = readState();
  const email = `oauth-${engine}-${Date.now().toString(36)}@example.com`;
  const r = await fetch(`${ORIGIN}/v1/members`, { method: "POST", headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, name: `OAuth ${engine}`, role: "admin" }) });
  expect(r.status, await r.clone().text()).toBe(201);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(serverCli(["sign-in-link", "--email", email, "--workspace", workspace]).trim());
  await page.getByRole("button", { name: /continue/i }).click();
  await page.waitForURL((u) => u.pathname === "/");
  const status = await page.evaluate(async (password) => {
    const session = await (await fetch("/v1/auth/session")).json() as { csrf_token: string };
    const res = await fetch("/v1/auth/password", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrf_token }, body: JSON.stringify({ password }) });
    return res.status;
  }, PASSWORD);
  expect(status).toBe(200);
  await ctx.close();
  return email;
}

/**
 * The client's end: a real HTTP server on a loopback port that records what the browser sends when the
 * consent page sends it back (a route can't catch a request that follows a redirect).
 */
async function clientCallback(): Promise<{ uri: string; port: number; arrived: Promise<{ url: URL; headers: IncomingHttpHeaders }>; close: () => void }> {
  let resolve!: (v: { url: URL; headers: IncomingHttpHeaders }) => void;
  const arrived = new Promise<{ url: URL; headers: IncomingHttpHeaders }>((r) => (resolve = r));
  const server = createServer((req, res) => {
    resolve({ url: new URL(req.url ?? "/", "http://localhost"), headers: req.headers });
    res.writeHead(200, { "Content-Type": "text/plain" }).end("the client got it");
  });
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  const port = (server.address() as AddressInfo).port;
  return { uri: `http://localhost:${port}/callback`, port, arrived, close: () => server.close() };
}

test("a signed-out browser signs in on the server's page, comes back to consent, and approving reaches the client with no Referer", async ({ browser, browserName }) => {
  const email = await adminWithPassword(browser, browserName);
  const clientId = await registerClient(`E2E client ${browserName}`);
  const verifier = randomBytes(32).toString("base64url");
  const state = `st-${randomBytes(8).toString("hex")}`;
  const cb = await clientCallback();
  const path = authorizePath(clientId, cb.uri, "ops", state, verifier);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const posts: { path: string; origin?: string; site?: string; referer?: string }[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST") void r.allHeaders().then((h) => posts.push({ path: new URL(r.url()).pathname, origin: h.origin, site: h["sec-fetch-site"], referer: h.referer }), () => {});
  });

  // Signed out: the server sends the browser to its sign-in page, carrying the whole request as return_to.
  await page.goto(path);
  await page.waitForURL((u) => u.pathname === "/auth/sign-in");
  expect(new URL(page.url()).searchParams.get("return_to")).toBe(path);
  await page.locator("#pw-email").fill(email);
  await page.locator("#pw").fill(PASSWORD);
  const consent = page.waitForResponse((r) => new URL(r.url()).pathname === "/oauth/authorize" && r.request().method() === "GET");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const consentRes = await consent;
  expect(consentRes.status()).toBe(200);
  // The consent page's URL carries the state: it is no-referrer, so neither it nor the code below reaches a Referer.
  expect(consentRes.headers()["referrer-policy"]).toBe("no-referrer");
  expect(consentRes.headers()["content-security-policy"]).toContain(`form-action 'self' http://localhost:${cb.port}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(`E2E client ${browserName}`);

  await page.getByRole("button", { name: "Allow" }).click();
  const arrival = await cb.arrived;
  // Let the browser finish arriving at the client before going anywhere else; otherwise the next
  // navigation can race the redirect (seen in WebKit on a slow machine).
  await page.waitForURL((u) => u.pathname === "/callback", { timeout: 10_000 }).catch(() => {});
  cb.close();
  expect(arrival.url.searchParams.get("state")).toBe(state);
  const code = arrival.url.searchParams.get("code")!;
  expect(code).toBeTruthy();
  expect(arrival.headers.referer).toBeUndefined();

  // The decision went out as the page's own form post; the server accepted it (recorded per engine).
  const decision = posts.find((p) => p.path === "/oauth/authorize");
  expect(decision, browserName).toBeTruthy();
  expect(decision!.site).toBe("same-origin");
  expect([ORIGIN, "null"]).toContain(decision!.origin);
  expect(posts.filter((p) => p.referer && (p.referer.includes(state) || p.referer.includes(code)))).toEqual([]);
  test.info().annotations.push({ type: "consent-post", description: `${browserName}: Origin ${decision!.origin ?? "(none)"}, Sec-Fetch-Site ${decision!.site ?? "(none)"}` });

  // The code is good: the client exchanges it.
  const token = await fetch(`${ORIGIN}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: cb.uri, client_id: clientId, resource: `${MCP_ORIGIN}/mcp/ops` }).toString() });
  expect(token.status).toBe(200);
  // And the member sees the app in the server's connected-apps page.
  await page.goto("/auth/apps");
  await expect(page.getByText(`E2E client ${browserName}`)).toBeVisible();
  await ctx.close();
});

test("the app's sign-in screen keeps an OAuth return path, also to confirm it's you for an admin connection", async ({ browser, browserName }) => {
  const email = await adminWithPassword(browser, `${browserName}-app`);
  const clientId = await registerClient(`E2E admin client ${browserName}`);
  const cb = await clientCallback();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Signed out, at the app's own sign-in screen with an authorization request to come back to.
  const ops = authorizePath(clientId, cb.uri, "ops", "st-app", randomBytes(32).toString("base64url"));
  await page.goto(`/sign-in?return_to=${encodeURIComponent(ops)}`);
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  // A full page load to the server's consent page (not a client route: the app has none there).
  await page.waitForURL((u) => u.pathname === "/oauth/authorize");
  expect(`${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe(ops);
  await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();

  // Re-authentication for an admin connection: the app's confirm-it's-you screen, then back to consent.
  const admin = authorizePath(clientId, cb.uri, "admin", "st-admin", randomBytes(32).toString("base64url"));
  await page.goto(`/sign-in?reauth=1&return_to=${encodeURIComponent(admin)}`);
  await expect(page.getByRole("heading", { name: "Confirm it's you" })).toBeVisible();
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await page.waitForURL((u) => u.pathname === "/oauth/authorize");
  await expect(page.getByText(/admin/i).first()).toBeVisible();
  await page.getByRole("button", { name: "Allow" }).click();
  const arrival = await cb.arrived;
  cb.close();
  expect(arrival.url.searchParams.get("state")).toBe("st-admin");
  expect(arrival.url.searchParams.get("code")).toBeTruthy();
  expect(arrival.headers.referer).toBeUndefined();
  await ctx.close();
});
