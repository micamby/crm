import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { buildApp, type Env } from "../src/api/app.js";
import { createServerLink } from "../src/auth/signin.js";
import { resetConfig, webUiOn } from "../src/config.js";
import { routes } from "../src/api/registry.js";
import { isAppRoute, parseRouteManifest, resetWebUi, webUi } from "../src/web/static.js";
import { call, newWorkspace, ORIGIN, type Workspace } from "./helpers.js";

/**
 * Serving the built web UI from the API's origin (packages/web): a fake build in a temp directory,
 * turned on for these tests only (test/env.ts sets WEB_UI=false for every other suite).
 */
const SHELL = `<!doctype html><html><head><meta name="hlcrm-style-nonce" content="__HLCRM_STYLE_NONCE__"><script type="module" src="/assets/app-abc123.js"></script></head><body><div id="root"></div></body></html>`;

const MANIFEST_SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "src", "app-routes.json");

let dir: string;
let ui: Hono<Env>;
let ws: Workspace;

function withEnv(env: Record<string, string | undefined>, fn: () => Hono<Env>): Hono<Env> {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  resetConfig();
  resetWebUi();
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    resetConfig();
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "hlcrm-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), SHELL);
  writeFileSync(join(dir, "app-routes.json"), readFileSync(MANIFEST_SRC));
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.info('app');");
  writeFileSync(join(dir, "assets", "app-abc123.css"), "body{}");
  writeFileSync(join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  writeFileSync(join(dir, ".secret"), "nope");
  const outside = mkdtempSync(join(tmpdir(), "hlcrm-outside-"));
  writeFileSync(join(outside, "passwd"), "outside");
  symlinkSync(join(outside, "passwd"), join(dir, "assets", "link.js"));
  ui = withEnv({ WEB_UI: "true", WEB_UI_DIR: dir }, () => buildApp());
  ws = await newWorkspace("WebUI");
});

afterAll(() => {
  resetWebUi();
});

const HTML = { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
const page = (path: string, init: RequestInit = {}) => ui.request(path, { ...init, headers: { ...HTML, ...(init.headers as Record<string, string> | undefined) } });
const isShell = async (r: Response) => r.status === 200 && (await r.text()).includes('<div id="root">');

describe("web UI serving", () => {
  it("serves the shell at / with a nonce-based CSP, no-referrer and never stored", async () => {
    const a = await page("/");
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toMatch(/^text\/html/);
    expect(a.headers.get("cache-control")).toBe("no-store");
    const csp = a.headers.get("content-security-policy")!;
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("frame-ancestors 'none'");
    // no-referrer everywhere: the app's own fetch() writes still send their Origin.
    expect(a.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await ui.request("/v1/me")).headers.get("referrer-policy")).toBe("no-referrer");
    expect((await ui.request("/auth/sign-in")).headers.get("referrer-policy")).toBe("no-referrer");
    const body = await a.text();
    expect(Number(a.headers.get("content-length"))).toBe(Buffer.byteLength(body));
    expect(body).toContain(`content="${nonce}"`);
    expect(body).not.toContain("__HLCRM_STYLE_NONCE__");
    const b = await page("/");
    expect(/'nonce-([^']+)'/.exec(b.headers.get("content-security-policy")!)![1]).not.toBe(nonce);
    // HEAD: the same headers and length, no body.
    const head = await page("/o/contact", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get("content-length"))).toBe(Buffer.byteLength(body));
    expect(await head.text()).toBe("");
  });

  it("serves the shell only for the app's own routes, to a browser asking for HTML", async () => {
    for (const p of ["/", "/o/contact", "/o/deal/deal_01ABC?view=v_1", "/settings/members", "/board", "/tasks", "/inbox", "/sign-in?return_to=%2F", "/signed-out",
      // An app route whose last segment has a dot is still the app's.
      "/o/contact/con_01.v2", "/settings/schema/my.object"]) {
      expect(await isShell(await page(p)), p).toBe(true);
    }
    // Not to a client that asks for JSON (an OAuth client, a script) or names no type.
    for (const accept of ["application/json", "", "text/plain"]) {
      const r = await ui.request("/o/contact", { headers: accept ? { Accept: accept } : {} });
      expect(r.status, accept).toBe(404);
      expect(r.headers.get("content-type"), accept).toContain("application/problem+json");
    }
    // Not for other methods.
    expect((await page("/o/contact", { method: "POST" })).status).toBe(404);
  });

  it("answers API-owned and unknown paths with the API's JSON 404, whatever their case or encoding", async () => {
    for (const p of ["/mcp", "/mcp/ops", "/oauth/x/y", "/.well-known/x", "/.well-known/oauth-protected-resource/mcp/nope",
      "/healthz/x", "/openapi.json/x", "/V1/me", "/v1%2fme", "/v1%2Fme", "/AUTH/sign-in", "/Auth/nope", "/v1;/me", "/auth;/x", "/objects/contact",
      "/assets/missing-123.js", "/robots.txt", "/v1/nope", "/auth/nope-page", "/%2e%2e/%2e%2e/etc/passwd", "/o%2f..%2fv1", "/%zz", "/index.htm", "/apple-touch-icon.png"]) {
      const r = await page(p);
      // 404, or 401 for a path under /v1 (authentication comes first there).
      expect(r.status, p).toBe(p.startsWith("/v1/") ? 401 : 404);
      expect(r.headers.get("content-type"), p).toContain("application/problem+json");
      expect(await r.text(), p).not.toContain('<div id="root">');
    }
    // An API path keeps answering as the API does.
    const v1 = await page("/v1/me");
    expect(v1.status).toBe(401);
    expect(v1.headers.get("content-type")).toContain("application/problem+json");
    expect((await ui.request("/healthz")).status).toBe(200);
  });

  it("leaves every server route's answer as it is without the UI: /oauth, /.well-known, /auth (pages and apps), /mcp, /v1, any method and Accept", async () => {
    const plain = withEnv({ WEB_UI: "false" }, () => buildApp());
    withEnv({ WEB_UI: "true", WEB_UI_DIR: dir }, () => (webUi(), ui));
    const paths = [
      "/oauth/authorize", "/oauth/authorize?response_type=code&client_id=nope", "/oauth/token", "/oauth/revoke", "/oauth/register", "/oauth/other",
      "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration", "/.well-known/oauth-protected-resource/mcp/ops",
      "/.well-known/oauth-protected-resource/mcp/admin", "/.well-known/other",
      "/auth/apps", "/auth/apps/revoke", "/auth/sign-in", "/auth/signed-in", "/auth/password", "/auth/link", "/auth/capabilities", "/auth/other",
      "/mcp", "/mcp/ops", "/mcp/admin", "/v1/auth/apps", "/v1/apps", "/v1/automations", "/v1/packs", "/v1/objects",
    ];
    const accepts: Record<string, string>[] = [HTML, { Accept: "application/json" }, {}];
    for (const path of paths) {
      for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        for (const headers of accepts) {
          const label = `${method} ${path} ${headers.Accept ?? "(no Accept)"}`;
          const [withUi, without] = [await ui.request(path, { method, headers }), await plain.request(path, { method, headers })];
          // Failed authentication under /v1 is limited per address across both apps: 401 and 429 are the same answer here.
          const norm = (st: number) => (path.startsWith("/v1/") && st === 429 ? 401 : st);
          expect(norm(withUi.status), label).toBe(norm(without.status));
          expect(withUi.headers.get("content-type"), label).toBe(without.headers.get("content-type"));
          expect(withUi.headers.get("location"), label).toBe(without.headers.get("location"));
          const text = method === "HEAD" ? "" : await withUi.text();
          expect(text, label).not.toContain('<div id="root">');
          expect(withUi.headers.get("content-security-policy") ?? "", label).not.toContain("nonce-");
        }
      }
    }
    resetWebUi();
  });

  it("caches hashed assets for a year and revalidates other files with ETag and Last-Modified", async () => {
    const js = await ui.request("/assets/app-abc123.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/^text\/javascript/);
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const icon = await ui.request("/favicon.svg");
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(icon.headers.get("cache-control")).toBe("no-cache");
    const etag = icon.headers.get("etag")!;
    const modified = icon.headers.get("last-modified")!;
    expect(etag).toMatch(/^"[\w-]+"$/);
    expect(Number(icon.headers.get("content-length"))).toBe((await icon.text()).length);
    expect((await ui.request("/favicon.svg", { headers: { "If-None-Match": etag } })).status).toBe(304);
    expect((await ui.request("/favicon.svg", { headers: { "If-None-Match": `W/${etag}, "other"` } })).status).toBe(304);
    expect((await ui.request("/favicon.svg", { headers: { "If-None-Match": '"other"' } })).status).toBe(200);
    expect((await ui.request("/favicon.svg", { headers: { "If-Modified-Since": modified } })).status).toBe(304);
    expect((await ui.request("/favicon.svg", { headers: { "If-Modified-Since": "Thu, 01 Jan 1970 00:00:00 GMT" } })).status).toBe(200);
    const head = await ui.request("/assets/app-abc123.css", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("6");
    expect(await head.text()).toBe("");
  });

  it("serves a rebuilt file and shell without a restart", async () => {
    writeFileSync(join(dir, "favicon.svg"), "<svg xmlns='http://www.w3.org/2000/svg' id='v2'/>");
    utimesSync(join(dir, "favicon.svg"), new Date(), new Date(Date.now() + 5000));
    writeFileSync(join(dir, "index.html"), SHELL.replace("<body>", "<body><!-- v2 -->"));
    utimesSync(join(dir, "index.html"), new Date(), new Date(Date.now() + 5000));
    await new Promise((r) => setTimeout(r, 2100));
    expect(await (await ui.request("/favicon.svg")).text()).toContain("v2");
    expect(await (await page("/")).text()).toContain("<!-- v2 -->");
  });

  it("serves nothing outside the build: dot files, traversal and symlinks out of it", async () => {
    for (const p of ["/.secret", "/assets/..%2f.secret", "/assets/link.js", "/assets/%00.js", "/assets/%2e%2e/.secret"]) {
      const r = await page(p);
      expect(r.status, p).toBe(404);
      const text = await r.text();
      expect(text, p).not.toContain("nope");
      expect(text, p).not.toContain("outside");
    }
  });

  it("knows every top-level route of the app (packages/web/src/app-routes.json)", async () => {
    const routes = parseRouteManifest(readFileSync(MANIFEST_SRC, "utf8"));
    expect([...routes].sort()).toEqual(["", "board", "inbox", "o", "settings", "sign-in", "signed-out", "tasks"]);
    // Nothing the API owns, or may own, is an app route.
    for (const reserved of ["v1", "auth", "oauth", "mcp", ".well-known", "healthz", "readyz", "openapi.json", "assets"]) expect(routes.has(reserved), reserved).toBe(false);
    expect(isAppRoute({ routes }, "/O/contact")).toBe(true);
    expect(isAppRoute({ routes }, "/o%2fcontact")).toBe(true);
    expect(isAppRoute({ routes }, "/v1%2fme")).toBe(false);
    expect(() => parseRouteManifest('{"routes": ["/v1/../x"]}')).toThrow();
  });

  it("is off with WEB_UI=false (any case) or without a build, leaving the API as it was", async () => {
    for (const v of ["false", "FALSE", " False ", "0"]) {
      const off = withEnv({ WEB_UI: v, WEB_UI_DIR: dir }, () => buildApp());
      const r = await off.request("/", { headers: HTML });
      expect(r.status, v).toBe(404);
      expect(r.headers.get("content-type")).toContain("application/problem+json");
    }
    expect(webUiOn("TRUE")).toBe(true);
    expect(webUiOn(undefined)).toBe(true);
    const missing = withEnv({ WEB_UI: "true", WEB_UI_DIR: join(dir, "no-such-dir") }, () => buildApp());
    expect((await missing.request("/o/contact", { headers: HTML })).status).toBe(404);
    resetWebUi();
  });

  it("without a route manifest (an older build), serves the shell at / only", async () => {
    const old = mkdtempSync(join(tmpdir(), "hlcrm-web-old-"));
    writeFileSync(join(old, "index.html"), SHELL);
    const app = withEnv({ WEB_UI: "true", WEB_UI_DIR: old }, () => buildApp());
    expect(await isShell(await app.request("/", { headers: HTML }))).toBe(true);
    expect((await app.request("/o/contact", { headers: HTML })).status).toBe(404);
    resetWebUi();
  });

  it("sends a sign-in without a return path to the app when the UI is served", async () => {
    const link = await createServerLink(ws.ownerEmail, ws.id, "test");
    const token = new URL(link.url).searchParams.get("token")!;
    const post = (app: Hono<Env>) => app.request("/auth/server-link", { method: "POST", headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    withEnv({ WEB_UI: "true", WEB_UI_DIR: dir }, () => (webUi(), ui));
    const served = await (await post(ui)).json() as { return_to: string };
    expect(served.return_to).toBe("/");
    resetWebUi();
    const link2 = await createServerLink(ws.ownerEmail, ws.id, "test");
    const token2 = new URL(link2.url).searchParams.get("token")!;
    const plain = await (await buildApp().request("/auth/server-link", { method: "POST", headers: { Origin: ORIGIN, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" }, body: JSON.stringify({ token: token2 }) })).json() as { return_to: string };
    expect(plain.return_to).toBe("/auth/signed-in");
  });
});

describe("the web UI's request helper", () => {
  it("counts as heavy exactly the requests the server's heavy-request gate counts, so it queues them two at a time", async () => {
    // Loaded by path so the server's typecheck doesn't take in the web package (its imports are bundler-style).
    const webClient = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "src", "lib", "api", "client.ts");
    const { isHeavy } = await import(webClient) as { isHeavy: (method: string, path: string, opts: { body?: unknown; query?: Record<string, unknown> }) => boolean };
    const heavy = routes.filter((r) => r.heavy !== undefined && r.heavy !== false);
    expect(heavy.length).toBeGreaterThan(10);
    for (const r of heavy) {
      const path = r.path.replace(/:object/g, "contact").replace(/:name/g, "recruiting").replace(/:[a-z_]+/g, "x_1");
      const heavyArgs = { body: { count: true, dry_run: true }, query: { count: "true" } };
      const plainArgs = { body: { count: false, dry_run: false }, query: {} };
      const serverSays = (args: { body: unknown; query: unknown }) => (typeof r.heavy === "function" ? Boolean((r.heavy as (b: unknown, q: unknown) => boolean)(args.body, args.query)) : r.heavy === true);
      expect(isHeavy(r.method, path, heavyArgs), `${r.method} ${r.path} (heavy)`).toBe(serverSays(heavyArgs));
      expect(isHeavy(r.method, path, plainArgs), `${r.method} ${r.path} (plain)`).toBe(serverSays(plainArgs));
    }
    // And nothing the server doesn't count.
    for (const r of routes.filter((x) => x.heavy === undefined || x.heavy === false)) {
      const path = r.path.replace(/:object/g, "contact").replace(/:[a-z_]+/g, "x_1");
      expect(isHeavy(r.method, path, { body: { count: true, dry_run: true }, query: {} }), `${r.method} ${r.path}`).toBe(false);
    }
  });
});

describe("describe: status moves", () => {
  it("lists the category moves of standard status fields, and the categories only an operation may set", async () => {
    const lead = (await call("GET", "/v1/objects/lead", { key: ws.keys.ops })).json.data;
    const status = lead.fields.find((f: { name: string }) => f.name === "status");
    expect(status.category_transitions.qualified).toContain("converted");
    expect(status.category_transitions.disqualified).toEqual(["working"]);
    expect(status.operation_only_categories).toEqual(["converted"]);
    const task = (await call("GET", "/v1/objects/task", { key: ws.keys.ops })).json.data;
    expect(task.fields.find((f: { name: string }) => f.name === "status").category_transitions.done).toEqual(["open"]);
    // Fields without a machine say nothing.
    const priority = task.fields.find((f: { name: string }) => f.name === "priority");
    expect(priority.category_transitions).toBeUndefined();
  });
});
