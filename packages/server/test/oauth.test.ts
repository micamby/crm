import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAuthLimiter } from "../src/api/app.js";
import { LIMITS, addressKey, hit, resetSignInLimits } from "../src/auth/limits.js";
import { safeReturnTo, settleSignInTasks } from "../src/auth/signin.js";
import { assertStartupConfig, oauthSettings, randomEnough, resetConfig } from "../src/config.js";
import { decodeId } from "../src/lib/ids.js";
import { logger } from "../src/lib/logger.js";
import { safeRequest } from "../src/lib/outbound.js";
import { buildMcpApp, resetMcpLimiter } from "../src/mcp/http.js";
import { clientIdUrlProblem, pruneClients, resetClientCaches, resolveClient, setDocumentTransport, settleClientRefreshes, type DocumentTransport } from "../src/oauth/clients.js";
import { SERVICE_HEADER } from "../src/oauth/scopes.js";
import { resetKeySets } from "../src/oauth/token.js";
import { setMailer } from "../src/providers/mailer.js";
import { app as apiApp, Browser, call, FakeMailer, memberWithKey, newWorkspace, ORIGIN, signedIn, uniqueEmail, type Workspace } from "./helpers.js";

/**
 * OAuth for the remote MCP servers (ADR 0010), end to end through the in-process API and MCP apps, with
 * a small OAuth client written here: discovery from a 401, a metadata-document client (served by a fake
 * through the injectable document transport) or a dynamically registered one, authorize, consent,
 * token, MCP calls in both protocol revisions, refresh and revocation. Then every refusal.
 */

const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
const owner = postgres(process.env.TEST_MIGRATOR_URL!, { max: 1, onnotice: () => {} });
afterAll(async () => {
  setDocumentTransport(null);
  await sql.end();
  await owner.end();
});

const s = () => oauthSettings()!;
const apiFetch: typeof fetch = async (input, init) => apiApp.request(input instanceof Request ? input : String(input), init);
const mcpApp = buildMcpApp({ apiUrl: "http://api.local", fetch: apiFetch, oauth: oauthSettings() });
const mcpFetch: typeof fetch = async (input, init) => mcpApp.request(input instanceof Request ? input : String(input), init);

/** Every secret a test saw: none may appear in the database or the logs. */
const secrets = new Set<string>();
const logged: string[] = [];
const keep = <T extends string>(v: T): T => {
  secrets.add(v);
  return v;
};

// --- The fake client host (metadata documents and key sets) ----------------------------------------

interface Doc { status?: number; body: string; headers?: Record<string, string> }
const docs = new Map<string, Doc>();
const fetched: string[] = [];
const serve = (url: string, body: unknown, extra: Partial<Doc> = {}) => docs.set(url, { body: typeof body === "string" ? body : JSON.stringify(body), ...extra });
const fakeTransport: DocumentTransport = async (url) => {
  fetched.push(url);
  const d = docs.get(url);
  if (!d) throw new Error("unreachable");
  return { status: d.status ?? 200, body: d.body, headers: d.headers ?? {} };
};

const CIMD = "https://client.example/oauth/client.json";
const CIMD_REDIRECT = "https://client.example/callback";
const LOOPBACK_REDIRECT = "http://127.0.0.1/callback";

// --- A small OAuth client -------------------------------------------------------------------------

const pkce = () => {
  const verifier = keep(randomBytes(32).toString("base64url"));
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

/** Hidden fields of the consent form, unescaped. */
function hiddenFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)) {
    out[m[1]!.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))] = m[2]!.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  }
  return out;
}

interface Req { clientId: string; redirectUri: string; scope?: string; resource?: "ops" | "admin" | string | null; state?: string; extra?: Record<string, string> }

function authorizePath(r: Req, challenge: string): string {
  const q = new URLSearchParams({ response_type: "code", client_id: r.clientId, redirect_uri: r.redirectUri, code_challenge: challenge,
    code_challenge_method: "S256", state: r.state ?? "st-123" });
  if (r.scope) q.set("scope", r.scope);
  if (r.resource !== null) q.set("resource", r.resource === "ops" || r.resource === "admin" || r.resource === undefined ? s().resources[(r.resource ?? "ops") as "ops"] : r.resource);
  for (const [k, v] of Object.entries(r.extra ?? {})) q.set(k, v);
  return `/oauth/authorize?${q}`;
}

/** Authorize and approve in a signed-in browser; returns the code and verifier from the redirect. */
async function getCode(b: Browser, r: Req) {
  const p = pkce();
  const page = await b.request("GET", authorizePath(r, p.challenge));
  expect(page.status, page.text).toBe(200);
  const res = await b.request("POST", "/oauth/authorize", { form: { ...hiddenFields(page.text), decision: "approve" } });
  expect(res.status, res.text).toBe(303);
  const loc = new URL(res.headers.get("location")!);
  expect(loc.searchParams.get("iss")).toBe(ORIGIN);
  expect(loc.searchParams.get("state")).toBe(r.state ?? "st-123");
  return { code: keep(loc.searchParams.get("code")!), verifier: p.verifier, location: loc, page };
}

async function tokenRequest(form: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await apiApp.request("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString() });
  const json = await res.json() as Record<string, string>;
  if (json.access_token) keep(json.access_token);
  if (json.refresh_token) keep(json.refresh_token);
  return { status: res.status, json, headers: res.headers };
}

async function connect(b: Browser, r: Req) {
  const { code, verifier } = await getCode(b, r);
  const t = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: r.redirectUri, client_id: r.clientId,
    resource: s().resources[(r.resource ?? "ops") as "ops"] });
  expect(t.status, JSON.stringify(t.json)).toBe(200);
  return t.json as unknown as { access_token: string; refresh_token: string; scope: string; expires_in: number };
}

async function mcpLegacy(surface: "ops" | "admin", token: string): Promise<Client> {
  const client = new Client({ name: "oauth-test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`https://mcp.test/mcp/${surface}`), {
    fetch: mcpFetch, requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }));
  return client;
}

const META = "io.modelcontextprotocol/protocolVersion";
/** A 2026-07-28 request: version in the header and in _meta, method and name mirrored into headers. */
async function mcpModern(surface: "ops" | "admin", token: string | null, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const body = { jsonrpc: "2.0", id: 7, method, params: { ...params, _meta: { [META]: "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": {} } } };
  const h: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2026-07-28",
    "Mcp-Method": method, ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  for (const [k, v] of Object.entries(headers)) {
    if (v === "") delete h[k];
    else h[k] = v;
  }
  const res = await mcpApp.request(`https://mcp.test/mcp/${surface}`, { method: "POST", headers: h, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined };
}

const toolResult = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text).result;
const inTenant = <T>(tenant: string, fn: (tx: postgres.TransactionSql) => Promise<T>) => sql.begin(async (tx) => {
  await tx`SELECT set_config('app.tenant_id', ${tenant}, true)`;
  return fn(tx);
}) as Promise<T>;

async function register(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await apiApp.request("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

let ws: Workspace;
let ownerBrowser: Browser;
const mail = new FakeMailer();

beforeAll(async () => {
  ws = await newWorkspace("OAuth");
  setMailer(mail);
  for (const level of ["info", "warn", "error", "fatal", "debug"] as const) {
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { logged.push(JSON.stringify(args)); }) as never);
  }
  setDocumentTransport(fakeTransport);
  serve(CIMD, { client_id: CIMD, client_name: "Example Assistant", redirect_uris: [CIMD_REDIRECT, LOOPBACK_REDIRECT], token_endpoint_auth_method: "none" },
    { headers: { "cache-control": "public, max-age=600" } });
  ownerBrowser = await signedIn(ws.ownerEmail);
});
beforeEach(() => {
  resetSignInLimits();
  resetAuthLimiter();
  resetMcpLimiter();
  resetClientCaches();
  resetKeySets();
});

describe("discovery", () => {
  it("a 401 from each MCP endpoint points at its protected resource metadata, which names this server as the authorization server", async () => {
    for (const surface of ["ops", "admin"] as const) {
      const res = await mcpApp.request(`https://mcp.test/mcp/${surface}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(res.status).toBe(401);
      const header = res.headers.get("www-authenticate")!;
      const url = /resource_metadata="([^"]+)"/.exec(header)![1]!;
      expect(url).toBe(`https://mcp.test/.well-known/oauth-protected-resource/mcp/${surface}`);
      expect(header).toContain(surface === "ops" ? 'scope="ops:read ops:write"' : 'scope="admin ops:read"');
      const prm = await (await mcpApp.request(url)).json();
      expect(prm).toMatchObject({ resource: `https://mcp.test/mcp/${surface}`, authorization_servers: [ORIGIN], bearer_methods_supported: ["header"] });
      expect(prm.scopes_supported).not.toContain("offline_access");
      expect(prm.scopes_supported.includes("admin")).toBe(surface === "admin");
      // The API serves the same document, for one origin in front of both processes.
      expect(await (await apiApp.request(new URL(url).pathname)).json()).toEqual(prm);
    }
  });

  it("the authorization server metadata has the issuer it is fetched from and everything clients need", async () => {
    const md = await (await apiApp.request("/.well-known/oauth-authorization-server")).json();
    expect(md).toMatchObject({
      issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/oauth/authorize`, token_endpoint: `${ORIGIN}/oauth/token`, revocation_endpoint: `${ORIGIN}/oauth/revoke`,
      registration_endpoint: `${ORIGIN}/oauth/register`, code_challenge_methods_supported: ["S256"], response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true,
    });
    expect(md.token_endpoint_auth_methods_supported).toContain("none");
    expect(md.token_endpoint_auth_methods_supported).not.toContain("client_secret_basic");
    expect(md.scopes_supported).toEqual(["admin", "ops:write", "ops:read", "restricted:read"]);
    expect(await (await apiApp.request("/.well-known/openid-configuration")).json()).toEqual(md);
  });
});

describe("a metadata-document client, end to end", () => {
  it("signs in from the authorization request, consents, gets tokens, works on the ops server in both MCP revisions, refreshes and revokes", async () => {
    // No session: the authorization endpoint sends the browser to sign in and back.
    const b = new Browser();
    const p = pkce();
    const path = authorizePath({ clientId: CIMD, redirectUri: CIMD_REDIRECT, scope: "ops:read ops:write" }, p.challenge);
    const first = await b.request("GET", path);
    expect(first.status).toBe(303);
    const to = new URL(first.headers.get("location")!, ORIGIN);
    expect(to.pathname).toBe("/auth/sign-in");
    expect(to.searchParams.get("return_to")).toBe(path);
    expect(safeReturnTo(path)).toBe(path);
    await b.request("POST", "/auth/email", { body: { email: ws.ownerEmail, return_to: path } });
    await settleSignInTasks();
    const signed = await b.request("POST", "/auth/email/verify", { body: { code: mail.codeFor(ws.ownerEmail) } });
    expect(signed.json).toMatchObject({ status: "signed_in", return_to: path });

    const page = await b.request("GET", path);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Connect Example Assistant?");
    expect(page.text).toContain("client.example");
    expect(page.text).toContain("Create, change and archive records");
    expect(page.text).not.toContain("registered itself");
    // Not framed, no script, and the form may lead only here and to the app's redirect origin.
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'self' https://client.example");
    expect(page.headers.get("cache-control")).toBe("no-store");

    const approved = await b.request("POST", "/oauth/authorize", { form: { ...hiddenFields(page.text), decision: "approve" } });
    expect(approved.status).toBe(303);
    const loc = new URL(approved.headers.get("location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(CIMD_REDIRECT);
    expect(Object.fromEntries(loc.searchParams)).toMatchObject({ state: "st-123", iss: ORIGIN });
    const code = keep(loc.searchParams.get("code")!);

    const t = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: p.verifier, redirect_uri: CIMD_REDIRECT, client_id: CIMD, resource: s().resources.ops });
    expect(t.status).toBe(200);
    expect(t.headers.get("cache-control")).toBe("no-store");
    expect(t.headers.get("pragma")).toBe("no-cache");
    expect(t.json).toMatchObject({ token_type: "Bearer", scope: "ops:write ops:read", expires_in: 3600 });
    expect(t.json.access_token).toMatch(/^hlcrm_oat_/);
    expect(t.json.refresh_token).toMatch(/^hlcrm_ort_/);

    // 2025-11-25 (initialize, through the SDK client).
    const legacy = await mcpLegacy("ops", t.json.access_token!);
    const created = toolResult(await legacy.callTool({ name: "create_record", arguments: { object: "contact", values: { email: uniqueEmail("oauth") } } }));
    expect(created.id).toMatch(/^con_/);
    await legacy.close();
    // The audit entry names the member, the client and the grant, on the ops surface; never a token.
    const [entry] = await inTenant(ws.tenantId, (tx) => tx<{ actor_id: string; surface: string; details: Record<string, string> }[]>`
      SELECT actor_id, surface, details FROM audit_log WHERE action = 'contact.created' ORDER BY seq DESC LIMIT 1`);
    expect(entry).toMatchObject({ actor_id: decodeId(ws.ownerId)!.uuid, surface: "ops-mcp", details: { oauth_client: CIMD } });
    expect(entry!.details.oauth_grant).toMatch(/^ogr_/);

    // 2026-07-28 (no initialize; per-request metadata).
    const discover = await mcpModern("ops", t.json.access_token!, "server/discover");
    expect(discover.status).toBe(200);
    expect(discover.json.result).toMatchObject({ resultType: "complete", supportedVersions: expect.arrayContaining(["2026-07-28", "2025-11-25"]),
      capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "hl-crm-db-ops" } } });
    expect(discover.json.result.instructions).toContain("ops server");
    const list = await mcpModern("ops", t.json.access_token!, "tools/list");
    expect(list.json.result).toMatchObject({ resultType: "complete", ttlMs: expect.any(Number), cacheScope: "private" });
    expect(list.json.result.tools.map((x: { name: string }) => x.name)).toContain("search");
    const called = await mcpModern("ops", t.json.access_token!, "tools/call", { name: "list_pipelines", arguments: {} });
    expect(called.json.result.resultType).toBe("complete");
    expect(called.json.result.isError).toBeFalsy();

    // Refresh rotates both tokens; the new access token works.
    const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.json.refresh_token!, client_id: CIMD });
    expect(r.status).toBe(200);
    expect(r.json.refresh_token).not.toBe(t.json.refresh_token);
    expect((await mcpModern("ops", r.json.access_token!, "tools/list")).status).toBe(200);

    // Revoking the refresh token ends the grant: every token of it stops working.
    const rev = await apiApp.request("/oauth/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: r.json.refresh_token!, client_id: CIMD }).toString() });
    expect(rev.status).toBe(200);
    const after = await mcpModern("ops", r.json.access_token!, "tools/list");
    expect(after.status).toBe(401);
    expect(after.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: r.json.refresh_token!, client_id: CIMD })).json.error).toBe("invalid_grant");
    const audit = await inTenant(ws.tenantId, (tx) => tx<{ action: string }[]>`SELECT action FROM audit_log WHERE action LIKE 'oauth.%'`);
    expect(new Set(audit.map((a) => a.action))).toEqual(new Set(["oauth.consent_granted", "oauth.token_issued", "oauth.token_refreshed", "oauth.token_revoked"]));
  });

  it("caches the document per its Cache-Control, and doesn't refetch a document that just failed", async () => {
    const before = fetched.length;
    await getCode(ownerBrowser, { clientId: CIMD, redirectUri: CIMD_REDIRECT });
    expect(fetched.length).toBe(before);
    const [row] = await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.oauth_client', ${CIMD}, true)`;
      return tx<{ s: number }[]>`SELECT extract(epoch FROM expires_at - created_at)::int AS s FROM oauth_clients WHERE client_id = ${CIMD}`;
    });
    expect(row!.s).toBeGreaterThan(500);
    expect(row!.s).toBeLessThanOrEqual(86_400);
    const broken = "https://broken.example/client.json";
    serve(broken, { client_id: broken, redirect_uris: ["https://broken.example/cb"] });
    for (let i = 0; i < 3; i++) expect((await ownerBrowser.request("GET", authorizePath({ clientId: broken, redirectUri: "https://broken.example/cb" }, "x".repeat(43)))).status).toBe(400);
    expect(fetched.filter((u) => u === broken)).toHaveLength(1);
  });
});

describe("every client kind on every endpoint, in both MCP revisions", () => {
  it("connects a metadata-document client and a registered client to ops and admin, and calls tools with 2025-11-25 and 2026-07-28", async () => {
    const registered = (await register({ client_name: "Matrix", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], application_type: "web" })).json.client_id as string;
    for (const client of [{ clientId: CIMD, redirectUri: CIMD_REDIRECT }, { clientId: registered, redirectUri: "https://claude.ai/api/mcp/auth_callback" }]) {
      for (const surface of ["ops", "admin"] as const) {
        const t = await connect(ownerBrowser, { ...client, resource: surface, scope: surface === "ops" ? "ops:read ops:write" : "admin ops:read" });
        const legacy = await mcpLegacy(surface, t.access_token);
        expect((await legacy.listTools()).tools.length, `${client.clientId} ${surface}`).toBeGreaterThan(5);
        expect(toolResult(await legacy.callTool({ name: "get_schema_summary", arguments: {} }))).toBeTruthy();
        await legacy.close();
        const modern = await mcpModern(surface, t.access_token, "tools/call", { name: "describe_object", arguments: { object: "contact" } });
        expect(modern.status, `${client.clientId} ${surface}`).toBe(200);
        expect(modern.json.result).toMatchObject({ resultType: "complete", _meta: { "io.modelcontextprotocol/serverInfo": { name: `hl-crm-db-${surface}` } } });
      }
    }
  });
});

describe("a metadata-document client whose host is down", () => {
  it("keeps refreshing on its cached document, but can't start a new authorization until the document is back", async () => {
    const id = "https://flaky.example/client.json";
    serve(id, { client_id: id, client_name: "Flaky", redirect_uris: ["https://flaky.example/cb"] });
    const t = await connect(ownerBrowser, { clientId: id, redirectUri: "https://flaky.example/cb" });
    docs.delete(id);
    await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.oauth_client', ${id}, true)`;
      await tx`UPDATE oauth_clients SET expires_at = now() - interval '1 minute' WHERE client_id = ${id}`;
    });
    const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: id });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // The refresh used the cached copy and tried the host in the background; that failed, so a new authorization needs the document again.
    await settleClientRefreshes();
    expect((await ownerBrowser.request("GET", authorizePath({ clientId: id, redirectUri: "https://flaky.example/cb" }, pkce().challenge))).status).toBe(400);
  });
});

describe("a dynamically registered client on the admin server", () => {
  it("registers, warns on consent, gets an admin token with a fresh sign-in, and works in both MCP revisions", async () => {
    const reg = await register({ client_name: "Local Tool", redirect_uris: ["http://localhost:8787/callback"], application_type: "native",
      grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" });
    expect(reg.status).toBe(201);
    expect(reg.json).toMatchObject({ client_name: "Local Tool", token_endpoint_auth_method: "none", application_type: "native" });
    expect(reg.json).not.toHaveProperty("client_secret");
    const clientId = reg.json.client_id as string;
    const b = await signedIn(ws.ownerEmail);
    // Loopback: another port is the same redirect URI (RFC 8252 §7.3).
    const redirectUri = "http://localhost:51234/callback";
    const p = pkce();
    const page = await b.request("GET", authorizePath({ clientId, redirectUri, scope: "admin ops:read", resource: "admin" }, p.challenge));
    expect(page.status).toBe(200);
    expect(page.text).toContain("registered itself with this server");
    expect(page.text).toContain("on your own computer");
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self' http://localhost:51234");
    const res = await b.request("POST", "/oauth/authorize", { form: { ...hiddenFields(page.text), decision: "approve" } });
    const code = keep(new URL(res.headers.get("location")!).searchParams.get("code")!);
    const t = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: p.verifier, redirect_uri: redirectUri, client_id: clientId, resource: s().resources.admin });
    expect(t.status).toBe(200);
    expect(t.json.scope).toBe("admin ops:read");
    const admin = await mcpLegacy("admin", t.json.access_token!);
    expect((await admin.listTools()).tools.map((x) => x.name)).toContain("create_object");
    await admin.close();
    const modern = await mcpModern("admin", t.json.access_token!, "tools/call", { name: "list_members", arguments: {} });
    expect(modern.status).toBe(200);
    expect(JSON.stringify(modern.json.result)).toContain(ws.ownerEmail);
  });

  it("2026-07-28 requests must mirror their metadata in headers, and unknown versions name the supported ones", async () => {
    const t = await connect(ownerBrowser, { clientId: CIMD, redirectUri: CIMD_REDIRECT });
    const noMethod = await mcpModern("ops", t.access_token, "tools/list", {}, { "Mcp-Method": "" });
    expect(noMethod.status).toBe(400);
    expect(noMethod.json.error.code).toBe(-32020);
    const wrongName = await mcpModern("ops", t.access_token, "tools/call", { name: "search", arguments: { query: "x" } }, { "Mcp-Name": "create_record" });
    expect(wrongName.json.error.code).toBe(-32020);
    const encoded = await mcpModern("ops", t.access_token, "tools/call", { name: "list_pipelines", arguments: {} },
      { "Mcp-Name": `=?base64?${Buffer.from("list_pipelines").toString("base64")}?=` });
    expect(encoded.status).toBe(200);
    const future = await mcpModern("ops", t.access_token, "tools/list", {}, { "MCP-Protocol-Version": "2027-01-01" });
    expect(future.json.error.code).toBe(-32020);
    const res = await mcpApp.request("https://mcp.test/mcp/ops", { method: "POST", headers: { Authorization: `Bearer ${t.access_token}`, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2027-01-01", "Mcp-Method": "tools/list" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { [META]: "2027-01-01" } } }) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ code: -32022, data: { requested: "2027-01-01", supported: expect.arrayContaining(["2026-07-28"]) } });
    const gone = await mcpModern("ops", t.access_token, "ping");
    expect(gone.status).toBe(404);
    expect(gone.json.error.code).toBe(-32601);
    expect((await mcpApp.request("https://mcp.test/mcp/ops", { method: "GET", headers: { Authorization: `Bearer ${t.access_token}` } })).status).toBe(405);
  });
});

describe("the authorization endpoint refuses", () => {
  const page = (path: string) => ownerBrowser.request("GET", path);
  /** The error a refusal carries back to the app: a link on a page before the member acted (never an automatic redirect), a redirect after. */
  const errorOf = (r: { status: number; headers: Headers; text: string }) => {
    const href = r.status === 303 ? r.headers.get("location")! : /<a href="([^"]+)" rel="noreferrer">Return to the app/.exec(r.text)?.[1]?.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
    if (r.status !== 303) {
      expect(r.status).toBe(400);
      expect(r.headers.get("location")).toBeNull();
    }
    const u = new URL(href!);
    expect(`${u.origin}${u.pathname}`).toBe(CIMD_REDIRECT);
    expect(u.searchParams.get("iss")).toBe(ORIGIN);
    expect(u.searchParams.get("state")).toBe("st-123");
    return u.searchParams.get("error");
  };

  it("an unknown client or an unregistered redirect URI with a page, never a redirect", async () => {
    for (const r of [{ clientId: "oac_00000000000000000000000000", redirectUri: CIMD_REDIRECT }, { clientId: CIMD, redirectUri: "https://evil.example/callback" },
      { clientId: CIMD, redirectUri: "https://client.example/callback/../evil" }, { clientId: CIMD, redirectUri: "https://client.example/callback?x=1" },
      { clientId: CIMD, redirectUri: "http://127.0.0.1/other" }, { clientId: CIMD, redirectUri: "http://127.0.0.2/callback" }]) {
      const res = await page(authorizePath(r, "x".repeat(43)));
      expect(res.status, r.redirectUri).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(res.text).toContain("connect this app");
    }
    // Loopback with another port is the registered URI; the path must match.
    expect((await page(authorizePath({ clientId: CIMD, redirectUri: "http://127.0.0.1:43123/callback" }, "x".repeat(43)))).status).toBe(200);
  });

  it("missing or plain PKCE, a wrong response type, an unknown resource, a repeated parameter and prompt=none, back to the client with state and iss", async () => {
    const base = { clientId: CIMD, redirectUri: CIMD_REDIRECT };
    const q = (extra: Record<string, string>, drop: string[] = []) => {
      const u = new URL(authorizePath(base, pkce().challenge), ORIGIN);
      for (const d of drop) u.searchParams.delete(d);
      for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
      return `${u.pathname}${u.search}`;
    };
    expect(errorOf(await page(q({}, ["code_challenge"])))).toBe("invalid_request");
    expect(errorOf(await page(q({ code_challenge_method: "plain" })))).toBe("invalid_request");
    expect(errorOf(await page(q({}, ["code_challenge_method"])))).toBe("invalid_request");
    expect(errorOf(await page(q({ response_type: "token" })))).toBe("unsupported_response_type");
    expect(errorOf(await page(q({ resource: "https://elsewhere.example/mcp" })))).toBe("invalid_target");
    expect(errorOf(await page(q({ resource: "https://mcp.test/mcp/other" })))).toBe("invalid_target");
    expect(errorOf(await page(q({ prompt: "none" })))).toBe("consent_required");
    expect(errorOf(await page(`${q({})}&state=again`))).toBe("invalid_request");
    // Resource with upper-case scheme and host is the same resource.
    expect((await page(q({ resource: "HTTPS://MCP.TEST/mcp/ops" }))).status).toBe(200);
  });

  it("scopes the member's role can't use, scopes the workspace doesn't allow, and admin without a recent sign-in", async () => {
    const reader = await memberWithKey(ws, "read_only", ["ops:read"]);
    const rb = await signedIn((await call("GET", "/v1/members", { key: ws.keys.admin })).json.data.users.find((u: { id: string }) => u.id === reader.id).email);
    // ops:write narrows to ops:read for a reader, and the page says so.
    const t = await connect(rb, { clientId: CIMD, redirectUri: CIMD_REDIRECT, scope: "ops:read ops:write" });
    expect(t.scope).toBe("ops:read");
    // admin on the admin server can't be granted: the page offers only Cancel, and approving anyway issues nothing.
    const p = pkce();
    const blocked = await rb.request("GET", authorizePath({ clientId: CIMD, redirectUri: CIMD_REDIRECT, scope: "admin", resource: "admin" }, p.challenge));
    expect(blocked.text).toContain("on the admin server can be granted");
    expect(blocked.text).not.toContain('value="approve"');
    const forced = await rb.request("POST", "/oauth/authorize", { form: { ...hiddenFields(blocked.text), decision: "approve" } });
    expect(forced.status).toBe(403);
    expect(forced.headers.get("location")).toBeNull();
    // Cancel goes back with access_denied.
    expect(errorOf(await rb.request("POST", "/oauth/authorize", { form: { ...hiddenFields(blocked.text), decision: "deny" } }))).toBe("access_denied");

    // The workspace stops apps getting admin.
    expect((await call("PATCH", "/v1/workspace/sign-in", { key: ws.keys.admin, body: { oauth_scopes: ["ops:read", "ops:write"] } })).status).toBe(200);
    try {
      const w = await ownerBrowser.request("GET", authorizePath({ clientId: CIMD, redirectUri: CIMD_REDIRECT, scope: "admin", resource: "admin" }, pkce().challenge));
      expect(w.text).toContain("this workspace doesn&#39;t let apps have it");
      expect(w.text).not.toContain('value="approve"');
    } finally {
      await call("PATCH", "/v1/workspace/sign-in", { key: ws.keys.admin, body: { oauth_scopes: ["ops:read", "ops:write", "restricted:read", "admin"] } });
    }

    // admin needs a sign-in in the last 10 minutes.
    const stale = await signedIn(ws.ownerEmail);
    const sid = decodeId((await stale.request("GET", "/v1/auth/session")).json.session.id)!.uuid;
    await inTenant(ws.tenantId, (tx) => tx`UPDATE sessions SET signed_in_at = now() - interval '11 minutes' WHERE id = ${sid}`);
    const old = await stale.request("GET", authorizePath({ clientId: CIMD, redirectUri: CIMD_REDIRECT, scope: "admin", resource: "admin" }, pkce().challenge));
    expect(old.text).toContain("Sign in again");
    expect(old.text).not.toContain('value="approve"');
    const tried = await stale.request("POST", "/oauth/authorize", { form: { ...hiddenFields(old.text), decision: "approve" } });
    expect(tried.status).toBe(403);
  });

  it("a consent post without the session's CSRF token, from another origin, or cross-site, with a page and no redirect", async () => {
    const page1 = await ownerBrowser.request("GET", authorizePath({ clientId: CIMD, redirectUri: CIMD_REDIRECT }, pkce().challenge));
    const fields: Record<string, string> = { ...hiddenFields(page1.text), decision: "approve" };
    const noToken = Object.fromEntries(Object.entries(fields).filter(([k]) => k !== "csrf_token"));
    for (const [form, headers] of [[noToken, {}], [{ ...fields, csrf_token: "x".repeat(43) }, {}], [fields, { Origin: "https://evil.example" }],
      [fields, { "Sec-Fetch-Site": "cross-site" }], [fields, { Origin: "" }]] as const) {
      const r = await ownerBrowser.request("POST", "/oauth/authorize", { form, headers });
      expect(r.status).toBe(403);
      expect(r.headers.get("location")).toBeNull();
    }
    // Another session's token doesn't work either.
    const other = await signedIn(ws.ownerEmail);
    const r = await other.request("POST", "/oauth/authorize", { form: fields });
    expect(r.status).toBe(403);
  });
});

describe("server-rendered form posts under Referrer-Policy: no-referrer (Origin: null)", () => {
  const NULL_ORIGIN = (site: string) => ({ Origin: "null", "Sec-Fetch-Site": site });

  it("the consent page is no-referrer, and its own post with Origin: null is accepted only with Sec-Fetch-Site: same-origin", async () => {
    const page = await ownerBrowser.request("GET", authorizePath({ clientId: CIMD, redirectUri: CIMD_REDIRECT, state: "secret-state-1" }, pkce().challenge));
    expect(page.status).toBe(200);
    // The page's URL carries the client's state, and the redirect it leads to the code: neither may travel in a Referer.
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const fields = { ...hiddenFields(page.text), decision: "approve" };
    for (const site of ["", "cross-site", "same-site", "none"]) {
      const r = await ownerBrowser.request("POST", "/oauth/authorize", { form: fields, headers: NULL_ORIGIN(site) });
      expect(r.status, site).toBe(403);
      expect(r.headers.get("location"), site).toBeNull();
    }
    // The CSRF token is still needed with Origin: null.
    const noToken = await ownerBrowser.request("POST", "/oauth/authorize", { form: { ...fields, csrf_token: "x".repeat(43) }, headers: NULL_ORIGIN("same-origin") });
    expect(noToken.status).toBe(403);
    const ok = await ownerBrowser.request("POST", "/oauth/authorize", { form: fields, headers: NULL_ORIGIN("same-origin") });
    expect(ok.status, ok.text).toBe(303);
    expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
    const loc = new URL(ok.headers.get("location")!);
    expect(loc.searchParams.get("state")).toBe("secret-state-1");
    keep(loc.searchParams.get("code")!);
    // Cancel works the same way.
    const page2 = await ownerBrowser.request("GET", authorizePath({ clientId: CIMD, redirectUri: CIMD_REDIRECT }, pkce().challenge));
    const denied = await ownerBrowser.request("POST", "/oauth/authorize", { form: { ...hiddenFields(page2.text), decision: "deny" }, headers: NULL_ORIGIN("same-origin") });
    expect(denied.status).toBe(303);
    expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  });

  it("the connected-apps page's disconnect accepts Origin: null only with Sec-Fetch-Site: same-origin; /v1 never does", async () => {
    const b = await signedIn(ws.ownerEmail);
    await connect(b, { clientId: CIMD, redirectUri: CIMD_REDIRECT });
    const app = (await b.request("GET", "/v1/auth/apps")).json.data[0].id as string;
    const has = async () => ((await b.request("GET", "/v1/auth/apps")).json.data as { id: string }[]).some((g) => g.id === app);
    const page = await b.request("GET", "/auth/apps");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const csrf = hiddenFields(page.text).csrf_token!;
    for (const site of ["", "cross-site", "same-site"]) {
      expect((await b.request("POST", "/auth/apps/revoke", { form: { csrf_token: csrf, app }, headers: NULL_ORIGIN(site) })).status, site).toBe(403);
    }
    expect(await has()).toBe(true);
    // Never under /v1, form or JSON, even with Sec-Fetch-Site: same-origin and the CSRF token.
    expect((await b.request("DELETE", `/v1/auth/apps/${app}`, { headers: NULL_ORIGIN("same-origin") })).status).toBe(403);
    expect((await b.request("POST", "/v1/auth/sessions/revoke-others", { body: {}, headers: NULL_ORIGIN("same-origin") })).status).toBe(403);
    const r = await b.request("POST", "/auth/apps/revoke", { form: { csrf_token: csrf, app }, headers: NULL_ORIGIN("same-origin") });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/auth/apps?done=1");
    expect(await has()).toBe(false);
  });
});

describe("the token endpoint refuses", () => {
  const base = { clientId: CIMD, redirectUri: CIMD_REDIRECT };
  const exchange = (code: string, verifier: string, extra: Record<string, string> = {}) =>
    tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CIMD_REDIRECT, client_id: CIMD, ...extra });

  it("a wrong verifier, another client, another redirect URI, another resource, an expired code; then the right request still works", async () => {
    const { code, verifier } = await getCode(ownerBrowser, base);
    const other = (await register({ client_name: "Other", redirect_uris: [CIMD_REDIRECT] })).json.client_id as string;
    for (const extra of [{ code_verifier: pkce().verifier }, { client_id: other }, { redirect_uri: "https://client.example/other" },
      { resource: s().resources.admin }] as Record<string, string>[]) {
      const r = await exchange(code, verifier, extra);
      expect(r.status).toBe(400);
      expect(["invalid_grant", "invalid_target"]).toContain(r.json.error);
    }
    expect((await exchange(code, verifier, { resource: "https://elsewhere.example/mcp" })).json.error).toBe("invalid_target");
    expect((await exchange(code, verifier, { code_verifier: "short" })).json.error).toBe("invalid_request");
    expect((await exchange(code, verifier)).status).toBe(200);
    const late = await getCode(ownerBrowser, base);
    await inTenant(ws.tenantId, (tx) => tx`UPDATE oauth_codes SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`);
    expect((await exchange(late.code, late.verifier)).json.error).toBe("invalid_grant");
  });

  it("a code used twice, and revokes what the first use got", async () => {
    const { code, verifier } = await getCode(ownerBrowser, base);
    const first = await exchange(code, verifier);
    expect(first.status).toBe(200);
    expect((await mcpModern("ops", first.json.access_token!, "tools/list")).status).toBe(200);
    expect((await exchange(code, verifier)).json.error).toBe("invalid_grant");
    expect((await mcpModern("ops", first.json.access_token!, "tools/list")).status).toBe(401);
    const [a] = await inTenant(ws.tenantId, (tx) => tx`SELECT 1 FROM audit_log WHERE action = 'oauth.code_reuse_detected'`);
    expect(a).toBeTruthy();
  });

  it("client secrets, JSON bodies, repeated parameters and unknown grant types", async () => {
    const { code, verifier } = await getCode(ownerBrowser, base);
    const basic = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CIMD_REDIRECT },
      { Authorization: `Basic ${Buffer.from(`${CIMD}:secret`).toString("base64")}` });
    expect(basic.status).toBe(401);
    expect(basic.json.error).toBe("invalid_client");
    const json = await apiApp.request("/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CIMD_REDIRECT, client_id: CIMD }) });
    expect(json.status).toBe(400);
    const twice = await apiApp.request("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=authorization_code&code=${code}&code=${code}&code_verifier=${verifier}&redirect_uri=${encodeURIComponent(CIMD_REDIRECT)}&client_id=${encodeURIComponent(CIMD)}` });
    expect((await twice.json()).error).toBe("invalid_request");
    expect((await tokenRequest({ grant_type: "password", client_id: CIMD })).json.error).toBe("unsupported_grant_type");
    expect((await tokenRequest({ grant_type: "client_credentials", client_id: CIMD })).json.error).toBe("unsupported_grant_type");
    expect((await exchange(code, verifier)).status).toBe(200);
  });
});

describe("tokens", () => {
  const base = { clientId: CIMD, redirectUri: CIMD_REDIRECT };

  it("are bound to their MCP endpoint and never work on the REST API directly; API keys keep working on MCP", async () => {
    const ops = await connect(ownerBrowser, base);
    const admin = await connect(ownerBrowser, { ...base, scope: "admin ops:read", resource: "admin" });
    expect((await mcpModern("admin", ops.access_token, "tools/list")).status).toBe(401);
    expect((await mcpModern("ops", admin.access_token, "tools/list")).status).toBe(401);
    await expect(mcpLegacy("admin", ops.access_token)).rejects.toThrow();
    // Straight to /v1, with or without the surface it was issued for.
    for (const headers of [{}, { "X-HLCRM-Surface": "ops-mcp" }, { "X-Hlcrm-Mcp-Service": "x".repeat(43), "X-HLCRM-Surface": "ops-mcp" }] as Record<string, string>[]) {
      const r = await call("GET", "/v1/me", { key: ops.access_token, headers });
      expect(r.status).toBe(401);
    }
    // In a query string, it is nothing.
    expect((await mcpApp.request(`https://mcp.test/mcp/ops?access_token=${ops.access_token}`, { method: "POST", body: "{}" })).status).toBe(401);
    // An API key still takes the key path, unchanged.
    const keyed = await mcpLegacy("ops", ws.keys.ops);
    expect((await keyed.listTools()).tools.length).toBeGreaterThan(5);
    await keyed.close();
  });

  it("refresh tokens rotate; a used one revokes the grant; a refresh can narrow but never widen or move the token", async () => {
    const t = await connect(ownerBrowser, { ...base, scope: "ops:read ops:write" });
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CIMD, scope: "ops:write admin" })).json.error).toBe("invalid_scope");
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CIMD, resource: s().resources.admin })).json.error).toBe("invalid_target");
    const other = (await register({ client_name: "Other", redirect_uris: [CIMD_REDIRECT] })).json.client_id as string;
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: other })).json.error).toBe("invalid_grant");
    const narrow = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CIMD, scope: "ops:read" });
    expect(narrow.status).toBe(200);
    expect(narrow.json.scope).toBe("ops:read");
    const ro = await mcpLegacy("ops", narrow.json.access_token!);
    const write = await ro.callTool({ name: "create_record", arguments: { object: "account", values: { name: "Narrowed Co" } } });
    expect(write.isError).toBe(true);
    await ro.close();
    // The old refresh token again: theft is assumed and the whole grant ends.
    const replay = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CIMD });
    expect(replay.json.error).toBe("invalid_grant");
    expect((await mcpModern("ops", narrow.json.access_token!, "tools/list")).status).toBe(401);
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: narrow.json.refresh_token!, client_id: CIMD })).json.error).toBe("invalid_grant");
    const [a] = await inTenant(ws.tenantId, (tx) => tx`SELECT 1 FROM audit_log WHERE action = 'oauth.refresh_reuse_detected'`);
    expect(a).toBeTruthy();
  });

  it("revoking an access token ends only it; another client's revocation changes nothing", async () => {
    const t = await connect(ownerBrowser, base);
    const other = (await register({ client_name: "Other", redirect_uris: [CIMD_REDIRECT] })).json.client_id as string;
    const revoke = (token: string, clientId: string) => apiApp.request("/oauth/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: clientId }).toString() });
    expect((await revoke(t.access_token, other)).status).toBe(200);
    expect((await mcpModern("ops", t.access_token, "tools/list")).status).toBe(200);
    expect((await revoke(t.access_token, CIMD)).status).toBe(200);
    expect((await mcpModern("ops", t.access_token, "tools/list")).status).toBe(401);
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CIMD })).status).toBe(200);
    expect((await revoke("not-a-token", CIMD)).status).toBe(200);
  });

  it("follow the member's current role, object and field rules, and stop when the member is disabled", async () => {
    const roleRes = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: `oauth_role_${Date.now()}`, name: "OAuth role", permissions: ["records:read", "records:write"] } });
    const email = uniqueEmail("oauthm");
    const m = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email, name: "OAuth Member", role: roleRes.json.data.id } });
    const mb = await signedIn(email);
    const t = await connect(mb, base);
    const contact = (await call("POST", "/v1/objects/contact/records", { key: ws.keys.admin, body: { email: uniqueEmail("seen"), first_name: "Seen" } })).json.data;
    const c = await mcpLegacy("ops", t.access_token);
    expect(toolResult(await c.callTool({ name: "get_record", arguments: { id: contact.id } })).email).toBeTruthy();
    // A field rule takes effect on the next request.
    expect((await call("PATCH", `/v1/roles/${roleRes.json.data.id}`, { key: ws.keys.admin, body: { fields: { contact: { email: "none" } } } })).status).toBe(200);
    expect(toolResult(await c.callTool({ name: "get_record", arguments: { id: contact.id } }))).not.toHaveProperty("email");
    // An object rule too.
    const rule = await call("PATCH", `/v1/roles/${roleRes.json.data.id}`, { key: ws.keys.admin, body: { objects: { deal: { read: false, write: false, archive: false } } } });
    expect(rule.status, JSON.stringify(rule.json)).toBe(200);
    const denied = await c.callTool({ name: "query_records", arguments: { object: "deal" } });
    expect(denied.isError, JSON.stringify(denied)).toBe(true);
    // A role change.
    await call("PATCH", `/v1/members/${m.json.data.id}`, { key: ws.keys.admin, body: { role: "read_only" } });
    expect((await c.callTool({ name: "create_record", arguments: { object: "account", values: { name: "Not allowed" } } })).isError).toBe(true);
    await c.close();
    // Disabling ends every grant in the same transaction.
    const off = await call("PATCH", `/v1/members/${m.json.data.id}`, { key: ws.keys.admin, body: { active: false } });
    expect(off.json.data.apps_revoked).toBe(1);
    expect((await mcpModern("ops", t.access_token, "tools/list")).status).toBe(401);
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CIMD })).json.error).toBe("invalid_grant");
  });

  it("stop when the workspace turns apps off, and new connections can't be approved", async () => {
    const t = await connect(ownerBrowser, base);
    const off = await call("PATCH", "/v1/workspace/sign-in", { key: ws.keys.admin, body: { oauth_apps: false } });
    expect(off.json.data.oauth_apps).toBe(false);
    try {
      expect((await mcpModern("ops", t.access_token, "tools/list")).status).toBe(401);
      expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CIMD })).json.error).toBe("invalid_grant");
      const page = await ownerBrowser.request("GET", authorizePath(base, pkce().challenge));
      expect(page.text).toContain("doesn&#39;t allow connecting apps");
      expect(page.text).not.toContain('value="approve"');
      // An admin who isn't an owner can't change it.
      const admin = await memberWithKey(ws, "admin", ["admin"]);
      expect((await call("PATCH", "/v1/workspace/sign-in", { key: admin.key, body: { oauth_apps: true } })).status).toBe(403);
    } finally {
      await call("PATCH", "/v1/workspace/sign-in", { key: ws.keys.admin, body: { oauth_apps: true } });
    }
    // Turning it back on doesn't bring the revoked grant back.
    expect((await mcpModern("ops", t.access_token, "tools/list")).status).toBe(401);
  });

  it("a private_key_jwt client proves itself with a single-use signed assertion", async () => {
    const id = "https://assistant.example/oauth/client.json";
    const keys = await generateKeyPair("ES256");
    const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "ES256", use: "sig" };
    serve(id, { client_id: id, client_name: "Signed Assistant", redirect_uris: ["https://assistant.example/cb"], token_endpoint_auth_method: "private_key_jwt",
      jwks_uri: "https://assistant.example/oauth/jwks.json", grant_types: ["authorization_code", "refresh_token"] });
    serve("https://assistant.example/oauth/jwks.json", { keys: [jwk] });
    const assertion = (key: CryptoKey = keys.privateKey) => new SignJWT({}).setProtectedHeader({ alg: "ES256", kid: "k1" }).setIssuer(id).setSubject(id)
      .setAudience(`${ORIGIN}/oauth/token`).setJti(randomBytes(16).toString("hex")).setIssuedAt().setExpirationTime("2m").sign(key);
    const { code, verifier } = await getCode(ownerBrowser, { clientId: id, redirectUri: "https://assistant.example/cb" });
    const form = { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: "https://assistant.example/cb" };
    const JWT_BEARER = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
    expect((await tokenRequest({ ...form, client_id: id })).json.error).toBe("invalid_client");
    const stranger = await generateKeyPair("ES256");
    expect((await tokenRequest({ ...form, client_assertion_type: JWT_BEARER, client_assertion: await assertion(stranger.privateKey) })).json.error).toBe("invalid_client");
    const a = await assertion();
    const ok = await tokenRequest({ ...form, client_assertion_type: JWT_BEARER, client_assertion: a });
    expect(ok.status).toBe(200);
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: ok.json.refresh_token!, client_assertion_type: JWT_BEARER, client_assertion: a })).json.error)
      .toBe("invalid_client");
    expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: ok.json.refresh_token!, client_assertion_type: JWT_BEARER, client_assertion: await assertion() })).status)
      .toBe(200);
  });
});

describe("client metadata documents", () => {
  it("are fetched only from public https URLs and must describe themselves exactly", async () => {
    // Refused before anything is fetched: private and loopback addresses, internal names, http, no path, a query, dot segments.
    for (const id of ["https://127.0.0.1/c.json", "https://10.1.2.3/c.json", "https://[::1]/c.json", "https://169.254.169.254/latest", "https://localhost/c.json",
      "https://db.internal/c.json", "http://client.example/c.json", "https://client.example", "https://client.example/", "https://client.example/c.json?x=1",
      "https://client.example/a/../c.json", "https://user:pw@client.example/c.json"]) {
      expect(clientIdUrlProblem(id), id).not.toBeNull();
    }
    const before = fetched.length;
    await expect(resolveClient("https://127.0.0.1/c.json")).rejects.toThrow();
    expect(fetched.length).toBe(before);
    // With the real transport, a private address is refused by the outbound guard (no network needed: it is a literal).
    setDocumentTransport(null);
    try {
      await expect(resolveClient("https://192.168.1.10/client.json")).rejects.toThrow();
    } finally {
      setDocumentTransport(fakeTransport);
    }
    const cases: [string, Doc | unknown][] = [
      ["https://a.example/redirects.json", { status: 302, body: "", headers: { location: "https://evil.example/c.json" } }],
      ["https://a.example/big.json", { body: JSON.stringify({ client_id: "https://a.example/big.json", client_name: "x".repeat(40_000), redirect_uris: ["https://a.example/cb"] }) }],
      ["https://a.example/other-id.json", { client_id: "https://a.example/elsewhere.json", client_name: "X", redirect_uris: ["https://a.example/cb"] }],
      ["https://a.example/no-name.json", { client_id: "https://a.example/no-name.json", redirect_uris: ["https://a.example/cb"] }],
      ["https://a.example/no-redirects.json", { client_id: "https://a.example/no-redirects.json", client_name: "X" }],
      ["https://a.example/http-redirect.json", { client_id: "https://a.example/http-redirect.json", client_name: "X", redirect_uris: ["http://a.example/cb"] }],
      ["https://a.example/secret.json", { client_id: "https://a.example/secret.json", client_name: "X", redirect_uris: ["https://a.example/cb"], client_secret: "s" }],
      ["https://a.example/basic.json", { client_id: "https://a.example/basic.json", client_name: "X", redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_basic" }],
      ["https://a.example/not-json.json", { body: "<html>" }],
    ];
    for (const [url, doc] of cases) {
      if (doc && typeof doc === "object" && "body" in doc) docs.set(url, doc as Doc);
      else serve(url, doc);
      const res = await ownerBrowser.request("GET", authorizePath({ clientId: url, redirectUri: "https://a.example/cb" }, "x".repeat(43)));
      expect(res.status, url).toBe(400);
      expect(res.headers.get("location"), url).toBeNull();
    }
  });
});

describe("registration", () => {
  it("validates what is registered, honours application_type, is rate limited and lapses when unused", async () => {
    expect((await register({ client_name: "X", redirect_uris: ["http://client.example/cb"] })).json.error).toBe("invalid_redirect_uri");
    expect((await register({ client_name: "X", redirect_uris: ["myapp://cb"] })).json.error).toBe("invalid_redirect_uri");
    expect((await register({ client_name: "X", redirect_uris: ["https://client.example/cb#frag"] })).json.error).toBe("invalid_redirect_uri");
    expect((await register({ client_name: "X", redirect_uris: ["http://localhost:3000/cb"], application_type: "web" })).json.error).toBe("invalid_redirect_uri");
    expect((await register({ client_name: "X", redirect_uris: ["https://client.example/cb"], token_endpoint_auth_method: "client_secret_post" })).json.error)
      .toBe("invalid_client_metadata");
    expect((await register({ client_name: "X", redirect_uris: ["https://client.example/cb"], grant_types: ["client_credentials"] })).json.error).toBe("invalid_client_metadata");
    // Cursor-style: a web callback and a loopback one, with no application_type.
    const both = await register({ client_name: "Editor", redirect_uris: ["https://www.cursor.com/agents/mcp/oauth/callback", "http://localhost:8787/callback"] });
    expect(both.status).toBe(201);
    // A loopback URI among them makes it native, by the same rule as an explicit application_type (web can't use loopback).
    expect(both.json.application_type).toBe("native");
    // A name can't carry control or direction-changing characters.
    const odd = await register({ client_name: "Evil‮ppa\u0007", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    expect(odd.json.client_name).toBe("Evilppa");
    resetSignInLimits();
    let last = 0;
    for (let i = 0; i <= LIMITS.oauthRegister.max; i++) last = (await register({ client_name: `R${i}`, redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"] })).status;
    expect(last).toBe(429);
    // An unused registration lapses, and the worker's cleanup removes it.
    const id = both.json.client_id as string;
    await owner.begin(async (tx) => {
      await tx`SELECT set_config('app.oauth_client', ${id}, true)`;
      await tx`UPDATE oauth_clients SET expires_at = now() - interval '1 minute' WHERE client_id = ${id}`;
    });
    await expect(resolveClient(id)).rejects.toThrow(/not registered/);
    expect(await pruneClients()).toBeGreaterThanOrEqual(1);
  });
});

describe("connected apps", () => {
  it("members list and disconnect their own; admins theirs within the usual rules; the access review shows them; signing out everywhere disconnects them", async () => {
    const email = uniqueEmail("apps");
    const m = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email, name: "Apps Member", role: "member" } });
    const b = await signedIn(email);
    const t1 = await connect(b, { clientId: CIMD, redirectUri: CIMD_REDIRECT });
    const list = await b.request("GET", "/v1/auth/apps");
    expect(list.json.data).toHaveLength(1);
    expect(list.json.data[0]).toMatchObject({ client: { id: CIMD, name: "Example Assistant", redirect_host: "client.example", verified_by_document: true },
      scopes: ["ops:read", "ops:write"], resource: s().resources.ops });
    // The same app connected again replaces the earlier connection.
    const t2 = await connect(b, { clientId: CIMD, redirectUri: CIMD_REDIRECT });
    expect((await b.request("GET", "/v1/auth/apps")).json.data).toHaveLength(1);
    expect((await mcpModern("ops", t1.access_token, "tools/list")).status).toBe(401);
    // The page lists it and its form needs the CSRF token.
    const page = await b.request("GET", "/auth/apps");
    expect(page.text).toContain("Example Assistant");
    const gid = list.json.data[0].id as string;
    const current = (await b.request("GET", "/v1/auth/apps")).json.data[0].id as string;
    expect(gid).not.toBe(current);
    expect((await b.request("POST", "/auth/apps/revoke", { form: { app: current } })).status).toBe(403);
    // The admin view, and the access review.
    const viaAdmin = await call("GET", `/v1/apps?member=${m.json.data.id}`, { key: ws.keys.admin });
    expect(viaAdmin.json.data.map((g: { id: string }) => g.id)).toEqual([current]);
    const review = await call("GET", "/v1/access-review", { key: ws.keys.admin });
    expect(review.json.data.members.find((x: { id: string }) => x.id === m.json.data.id).apps.map((g: { id: string }) => g.id)).toEqual([current]);
    // A plain member can't see or revoke someone else's (the owner's), and gets the same 404 as for nothing.
    const ownerGrant = await connect(ownerBrowser, { clientId: CIMD, redirectUri: CIMD_REDIRECT });
    const ownerId = (await ownerBrowser.request("GET", "/v1/auth/apps")).json.data[0].id as string;
    expect((await b.request("DELETE", `/v1/apps/${ownerId}`)).status).toBe(404);
    expect((await b.request("GET", `/v1/apps?member=${ws.ownerId}`)).status).toBe(403);
    expect((await mcpModern("ops", ownerGrant.access_token, "tools/list")).status).toBe(200);
    // The page's form disconnects.
    const form = hiddenFields(page.text);
    expect((await b.request("POST", "/auth/apps/revoke", { form: { csrf_token: form.csrf_token!, app: current } })).status).toBe(303);
    expect((await mcpModern("ops", t2.access_token, "tools/list")).status).toBe(401);
    // Sign out everywhere disconnects apps too; a password change wouldn't.
    const t3 = await connect(b, { clientId: CIMD, redirectUri: CIMD_REDIRECT });
    const out = await b.request("POST", "/v1/auth/sessions/revoke-others");
    expect(out.json.apps_revoked).toBe(1);
    expect((await mcpModern("ops", t3.access_token, "tools/list")).status).toBe(401);
    // An admin disconnects a member's app with DELETE /v1/apps/:id.
    const t4 = await connect(b, { clientId: CIMD, redirectUri: CIMD_REDIRECT });
    const g4 = (await b.request("GET", "/v1/auth/apps")).json.data[0].id as string;
    expect((await call("DELETE", `/v1/apps/${g4}`, { key: ws.keys.admin })).status).toBe(200);
    expect((await mcpModern("ops", t4.access_token, "tools/list")).status).toBe(401);
    const [a] = await inTenant(ws.tenantId, (tx) => tx<{ details: { by_admin: boolean } }[]>`
      SELECT details FROM audit_log WHERE action = 'oauth.grant_revoked' ORDER BY seq DESC LIMIT 1`);
    expect(a!.details.by_admin).toBe(true);
  });
});

describe("abuse", () => {
  it("a flood of bad tokens at the MCP endpoint is cut off per address, without blocking a token that works", async () => {
    const good = await connect(ownerBrowser, { clientId: CIMD, redirectUri: CIMD_REDIRECT });
    expect((await mcpModern("ops", good.access_token, "tools/list")).status).toBe(200);
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await mcpModern("ops", `hlcrm_oat_${randomBytes(32).toString("base64url")}`, "tools/list")).status;
    expect(last).toBe(429);
    expect((await mcpModern("ops", good.access_token, "tools/list")).status).toBe(200);
  });
});

// --- Availability: no unauthenticated caller can cut a shared client off (security review, M1-M5, L1-L6) ---

/** Requests as if from `ip` (TRUST_PROXY on, the last X-Forwarded-For hop is the client). */
const from = (ip: string) => ({ "X-Forwarded-For": ip });
async function viaProxy<T>(fn: () => Promise<T>): Promise<T> {
  const prior = process.env.TRUST_PROXY;
  process.env.TRUST_PROXY = "true";
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prior;
  }
}
const junkRefresh = () => `hlcrm_ort_${randomBytes(32).toString("base64url")}`;
/** Runs fn with the RLS on oauth_clients lifted for the owner, committed: for filling the cache and registry in bulk. */
const asOwner = (fn: (tx: postgres.TransactionSql) => Promise<unknown>) => owner.begin(async (tx) => {
  await tx.unsafe("ALTER TABLE oauth_clients NO FORCE ROW LEVEL SECURITY");
  await fn(tx);
  await tx.unsafe("ALTER TABLE oauth_clients FORCE ROW LEVEL SECURITY");
});
const expireDocument = (id: string, by = "1 minute") => owner.begin(async (tx) => {
  await tx`SELECT set_config('app.oauth_client', ${id}, true)`;
  await tx`UPDATE oauth_clients SET expires_at = now() - ${by}::interval WHERE client_id = ${id}`;
});
/** A transport that holds requests for URLs containing /slow/ (or listed) until released. */
function gatedTransport(slow: (url: string) => boolean) {
  const gates: (() => void)[] = [];
  setDocumentTransport(async (url, opts) => {
    if (slow(url)) await new Promise<void>((r) => gates.push(r));
    return fakeTransport(url, opts);
  });
  return { gates, waitFor: async (n: number) => {
    for (let i = 0; i < 200 && gates.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  }, release: () => {
    for (const g of gates.splice(0)) g();
  } };
}

describe("availability: the token endpoint", () => {
  it("M1: junk requests naming a public client's ID can't use up its budget; they are cut off per client and address", async () => {
    const t = await connect(ownerBrowser, { clientId: CIMD, redirectUri: CIMD_REDIRECT });
    await viaProxy(async () => {
      const statuses: number[] = [];
      // 1,200 junk refreshes (the old per-client figure) from four addresses, naming the real client.
      for (const ip of ["203.0.113.11", "203.0.113.12", "203.0.113.13", "203.0.113.14"]) {
        for (let i = 0; i < LIMITS.oauthTokenUnproven.max; i++) statuses.push((await tokenRequest({ grant_type: "refresh_token", refresh_token: junkRefresh(), client_id: CIMD }, from(ip))).status);
      }
      expect(new Set(statuses)).toEqual(new Set([400]));
      // Each address is now cut off for that client...
      expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: junkRefresh(), client_id: CIMD }, from("203.0.113.11"))).status).toBe(429);
      // ...while a real refresh from elsewhere still works.
      const real = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CIMD }, from("198.51.100.200"));
      expect(real.status, JSON.stringify(real.json)).toBe(200);
    });
  });

  it("M1: unauthenticated authorization requests naming a client can't use up what signed-in members of that client need", async () => {
    const path = authorizePath({ clientId: CIMD, redirectUri: CIMD_REDIRECT }, pkce().challenge);
    await viaProxy(async () => {
      let sent = 0;
      for (let a = 0; sent <= LIMITS.oauthAuthorizeClient.max; a++) {
        for (let i = 0; i < LIMITS.oauthAuthorize.max && sent <= LIMITS.oauthAuthorizeClient.max; i++, sent++) {
          expect((await apiApp.request(path, { headers: from(`203.0.${a}.1`) })).status).toBe(303);
        }
      }
      expect((await ownerBrowser.request("GET", path, { headers: from("198.51.100.201") })).status).toBe(200);
    });
  });

  it("M2: bogus client IDs on a real client's host don't stop its key set being fetched, and unknown kids force at most one refetch a minute", async () => {
    const id = "https://signer.example/oauth/client.json";
    const jwks = "https://signer.example/oauth/jwks.json";
    const keys = await generateKeyPair("ES256");
    serve(id, { client_id: id, client_name: "Signer", redirect_uris: ["https://signer.example/cb"], token_endpoint_auth_method: "private_key_jwt", jwks_uri: jwks });
    serve(jwks, { keys: [{ ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] });
    const assertion = (key: CryptoKey = keys.privateKey, kid = "k1") => new SignJWT({}).setProtectedHeader({ alg: "ES256", kid }).setIssuer(id).setSubject(id)
      .setAudience(`${ORIGIN}/oauth/token`).setJti(randomBytes(16).toString("hex")).setIssuedAt().setExpirationTime("2m").sign(key);
    const JWT_BEARER = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
    const { code, verifier } = await getCode(ownerBrowser, { clientId: id, redirectUri: "https://signer.example/cb" });
    await viaProxy(async () => {
      for (let i = 0; i < 61; i++) {
        await tokenRequest({ grant_type: "authorization_code", code: "x", client_id: `https://signer.example/nope/${i}` }, from(i % 2 ? "203.0.113.21" : "203.0.113.22"));
      }
      const ok = await tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: "https://signer.example/cb",
        client_assertion_type: JWT_BEARER, client_assertion: await assertion() }, from("198.51.100.202"));
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
      // Assertions naming keys the set doesn't have: one forced refetch, not one each.
      const before = fetched.filter((u) => u === jwks).length;
      const stranger = await generateKeyPair("ES256");
      for (let i = 0; i < 5; i++) {
        const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: ok.json.refresh_token!, client_assertion_type: JWT_BEARER,
          client_assertion: await assertion(stranger.privateKey, `rotated-${i}`) }, from("203.0.113.23"));
        expect(r.json.error).toBe("invalid_client");
      }
      expect(fetched.filter((u) => u === jwks).length - before).toBe(1);
      // The real key still works afterwards.
      expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: ok.json.refresh_token!, client_assertion_type: JWT_BEARER,
        client_assertion: await assertion() }, from("198.51.100.202"))).status).toBe(200);
    });
  });
});

describe("availability: fetching client documents", () => {
  it("M3: slow documents from one address or many can't hold every fetch slot; a new client still connects", async () => {
    const g = gatedTransport((u) => u.includes("/slow/"));
    const pending: Promise<unknown>[] = [];
    try {
      await viaProxy(async () => {
        // Eight from one address: two hold slots, the rest are refused at once.
        const one = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
          const p = tokenRequest({ grant_type: "refresh_token", refresh_token: junkRefresh(), client_id: `https://slow${i}.example/slow/c.json` }, from("203.0.113.31"));
          pending.push(p);
          return Promise.race([p.then((r) => r.status), new Promise<number>((r) => setTimeout(() => r(0), 300))]);
        }));
        expect(one.filter((x) => x === 503)).toHaveLength(6);
        // Eight more from eight addresses, on eight domains.
        for (let i = 0; i < 8; i++) {
          pending.push(tokenRequest({ grant_type: "refresh_token", refresh_token: junkRefresh(), client_id: `https://slower${i}.example/slow/c.json` }, from(`203.0.113.${40 + i}`)));
        }
        await g.waitFor(10);
        const newcomer = "https://newcomer.example/client.json";
        serve(newcomer, { client_id: newcomer, client_name: "Newcomer", redirect_uris: ["https://newcomer.example/cb"] });
        const page = await ownerBrowser.request("GET", authorizePath({ clientId: newcomer, redirectUri: "https://newcomer.example/cb" }, pkce().challenge),
          { headers: from("198.51.100.203") });
        expect(page.status, page.text).toBe(200);
      });
    } finally {
      g.release();
      await Promise.all(pending);
      setDocumentTransport(fakeTransport);
    }
  });

  it("M3: a cached client whose copy just expired is served at once while its slow host is asked again in the background", async () => {
    const id = "https://swr.example/client.json";
    serve(id, { client_id: id, client_name: "Revalidated", redirect_uris: ["https://swr.example/cb"] });
    await getCode(ownerBrowser, { clientId: id, redirectUri: "https://swr.example/cb" });
    await expireDocument(id);
    const g = gatedTransport((u) => u === id);
    try {
      const page = ownerBrowser.request("GET", authorizePath({ clientId: id, redirectUri: "https://swr.example/cb" }, pkce().challenge));
      expect(await Promise.race([page.then((r) => r.status), new Promise<number>((r) => setTimeout(() => r(0), 1_000))])).toBe(200);
      await g.waitFor(1);
      expect(g.gates).toHaveLength(1);
    } finally {
      g.release();
      await settleClientRefreshes();
      setDocumentTransport(fakeTransport);
    }
  });

  it("M3: a fetch is bounded by one deadline for DNS and the request together", async () => {
    const server = createServer(() => {}).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    try {
      const started = Date.now();
      await expect(safeRequest(`http://127.0.0.1:${(server.address() as AddressInfo).port}/c.json`, { method: "GET", maxBytes: 1024, deadlineMs: 300 },
        { allowInsecure: true })).rejects.toThrow(/timed out/);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("M4: a full cache still refreshes cached clients and keeps new ones, making room; one host can't fill it", async () => {
    await asOwner((tx) => tx`INSERT INTO oauth_clients (id, client_id, kind, client_name, redirect_uris, application_type, token_endpoint_auth_method, expires_at, created_at)
      SELECT gen_random_uuid(), 'https://filler' || g || '.example/c.json', 'metadata_document', 'Filler', ARRAY['https://filler.example/cb'], 'web', 'none',
             now() + interval '1 hour', now() - interval '1 hour' FROM generate_series(1, 10000) g`);
    try {
      // A new client is fetched once, then served from the cache.
      const id = "https://after-full.example/client.json";
      serve(id, { client_id: id, client_name: "After Full", redirect_uris: ["https://after-full.example/cb"] });
      for (let i = 0; i < 3; i++) await getCode(ownerBrowser, { clientId: id, redirectUri: "https://after-full.example/cb" });
      expect(fetched.filter((u) => u === id)).toHaveLength(1);
      // An existing client's expired copy is refreshed in place.
      const t = await connect(ownerBrowser, { clientId: CIMD, redirectUri: CIMD_REDIRECT });
      await expireDocument(CIMD);
      expect((await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CIMD })).status).toBe(200);
      await settleClientRefreshes();
      const [row] = await owner.begin(async (tx) => {
        await tx`SELECT set_config('app.oauth_client', ${CIMD}, true)`;
        return tx<{ fresh: boolean }[]>`SELECT expires_at > now() AS fresh FROM oauth_clients WHERE client_id = ${CIMD}`;
      });
      expect(row!.fresh).toBe(true);
      // One host's documents fill at most their share: a new one replaces that host's least recently used.
      await asOwner((tx) => tx`INSERT INTO oauth_clients (id, client_id, kind, client_name, redirect_uris, application_type, token_endpoint_auth_method, expires_at, created_at)
        SELECT gen_random_uuid(), 'https://crowded.example/f' || g, 'metadata_document', 'Crowd', ARRAY['https://crowded.example/cb'], 'web', 'none',
               now() + interval '1 hour', now() - interval '1 hour' FROM generate_series(1, 500) g`);
      const crowded = "https://crowded.example/real.json";
      serve(crowded, { client_id: crowded, client_name: "Crowded", redirect_uris: ["https://crowded.example/cb"] });
      await getCode(ownerBrowser, { clientId: crowded, redirectUri: "https://crowded.example/cb" });
      const counts = await owner.begin(async (tx) => {
        await tx`SELECT set_config('app.oauth_registry', 'on', true)`;
        return tx<{ n: number; real: number }[]>`SELECT count(*)::int AS n, count(*) FILTER (WHERE client_id = ${crowded})::int AS real
          FROM oauth_clients WHERE starts_with(client_id, 'https://crowded.example/')`;
      });
      expect(counts[0]).toEqual({ n: 500, real: 1 });
    } finally {
      await asOwner((tx) => tx`DELETE FROM oauth_clients WHERE client_id LIKE 'https://filler%' OR client_id LIKE 'https://crowded.example/%'`);
    }
  });

  it("L4: refusals say nothing about the outside URL, and only port 443 is fetched", async () => {
    const urls = ["https://probe.example/redirect.json", "https://probe.example/missing.json", "https://probe.example/html.json", "https://probe.example/down.json"];
    docs.set(urls[0]!, { status: 302, body: "" });
    docs.set(urls[1]!, { status: 404, body: "" });
    docs.set(urls[2]!, { body: "<html>" });
    const pages = await Promise.all(urls.map((u) => ownerBrowser.request("GET", authorizePath({ clientId: u, redirectUri: "https://probe.example/cb" }, pkce().challenge))));
    const bodies = pages.map((p) => p.text.replace(/probe\.example[^"<]*/g, ""));
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toMatch(/HTTP|JSON|302|404|unreachable/);
    const tokens = await Promise.all(urls.map((u) => tokenRequest({ grant_type: "refresh_token", refresh_token: junkRefresh(), client_id: u })));
    expect(new Set(tokens.map((t) => JSON.stringify(t.json))).size).toBe(1);
    // The log has the reason.
    expect(logged.some((l) => l.includes("oauth_client_document_refused") && l.includes("HTTP 302"))).toBe(true);
    expect(clientIdUrlProblem("https://probe.example:8443/c.json")).toMatch(/443/);
    const before = fetched.length;
    await expect(resolveClient("https://probe.example:8443/c.json")).rejects.toThrow();
    expect(fetched.length).toBe(before);
    const odd = "https://probe.example/odd-keys.json";
    serve(odd, { client_id: odd, client_name: "Odd", redirect_uris: ["https://probe.example/cb"], token_endpoint_auth_method: "private_key_jwt", jwks_uri: "https://probe.example:8443/jwks" });
    await expect(resolveClient(odd)).rejects.toThrow();
  });

  it("L5: a cached copy is used at most a day past its cache life, whether or not the cleanup has run", async () => {
    const id = "https://gone.example/client.json";
    serve(id, { client_id: id, client_name: "Gone", redirect_uris: ["https://gone.example/cb"] });
    const t = await connect(ownerBrowser, { clientId: id, redirectUri: "https://gone.example/cb" });
    docs.delete(id);
    await expireDocument(id, "25 hours");
    const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: id });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("invalid_client");
  });
});

describe("availability: registration", () => {
  it("M5: the server-wide figure is an alarm, not a refusal; addresses count per IPv6 /64 and /48; a full registry evicts unused registrations, oldest first", async () => {
    const body = { client_name: "Flood", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] };
    await viaProxy(async () => {
      const statuses: number[] = [];
      for (let a = 0; a < 16; a++) for (let i = 0; i < LIMITS.oauthRegister.max; i++) statuses.push((await register(body, from(`203.0.113.${100 + a}`))).status);
      expect(new Set(statuses)).toEqual(new Set([201]));
      expect((await register(body, from("198.51.100.204"))).status).toBe(201);
      expect(logged.some((l) => l.includes("oauth_registration_surge"))).toBe(true);
      // One /64 is one address.
      for (let i = 0; i < LIMITS.oauthRegister.max; i++) expect((await register(body, from(`2001:db8:1:2::${i + 1}`))).status).toBe(201);
      expect((await register(body, from("2001:db8:1:2:ffff::9"))).status).toBe(429);
      expect(addressKey("2001:db8:1:2::1")).toBe(addressKey("2001:0db8:0001:0002:abcd::1"));
      expect(addressKey("::ffff:203.0.113.5")).toBe("203.0.113.5");
      // And one /48 has a ceiling of its own.
      let last = 0;
      for (let n = 0; n <= LIMITS.oauthRegisterNet.max / LIMITS.oauthRegister.max && last !== 429; n++) {
        for (let i = 0; i < LIMITS.oauthRegister.max && last !== 429; i++) last = (await register(body, from(`2001:db8:2:${n}::1`))).status;
      }
      expect(last).toBe(429);
    });
    // Fill the registry with registrations that issued tokens: those are never evicted, so a new one is refused.
    await asOwner((tx) => tx`INSERT INTO oauth_clients (id, client_id, kind, client_name, redirect_uris, application_type, token_endpoint_auth_method, expires_at, created_at, last_used_at)
      SELECT gen_random_uuid(), 'oac_filler' || g, 'registered', 'Filler', ARRAY['https://filler.example/cb'], 'web', 'none', now() + interval '1 day',
             now() - interval '2 hours' + make_interval(secs => g), now() FROM generate_series(1, 10000) g`);
    try {
      expect((await register(body)).status).toBe(503);
      // Unused ones younger than 15 minutes are kept too (someone may be approving one right now).
      await asOwner((tx) => tx`UPDATE oauth_clients SET last_used_at = NULL, created_at = now() WHERE client_id IN ('oac_filler1', 'oac_filler2')`);
      expect((await register(body)).status).toBe(503);
      // An old unused one makes room, the oldest first.
      await asOwner((tx) => tx`UPDATE oauth_clients SET last_used_at = NULL, created_at = now() - interval '3 hours' + make_interval(secs => substr(client_id, 11)::int)
        WHERE client_id IN ('oac_filler3', 'oac_filler4')`);
      expect((await register(body)).status).toBe(201);
      const left = await owner.begin(async (tx) => {
        await tx`SELECT set_config('app.oauth_registry', 'on', true)`;
        return tx<{ client_id: string }[]>`SELECT client_id FROM oauth_clients WHERE client_id IN ('oac_filler1', 'oac_filler2', 'oac_filler3', 'oac_filler4') ORDER BY client_id`;
      });
      expect(left.map((r) => r.client_id)).toEqual(["oac_filler1", "oac_filler2", "oac_filler4"]);
    } finally {
      await asOwner((tx) => tx`DELETE FROM oauth_clients WHERE client_id LIKE 'oac_filler%'`);
    }
  });
});

describe("availability: limiters and the MCP process", () => {
  it("L1: OAuth limits live apart from sign-in limits, and a blocked window survives eviction pressure", () => {
    for (let i = 0; i <= LIMITS.password.max; i++) hit(LIMITS.password, "victim");
    for (let i = 0; i <= LIMITS.oauthRegister.max; i++) hit(LIMITS.oauthRegister, "blocked");
    // Far more distinct keys than either store holds.
    for (let i = 0; i < 110_000; i++) hit(LIMITS.oauthToken, `churn-${i}`);
    for (let i = 0; i < 110_000; i++) hit(LIMITS.address, `churn-${i}`);
    expect(hit(LIMITS.password, "victim")).not.toBeNull();
    expect(hit(LIMITS.oauthRegister, "blocked")).not.toBeNull();
  });

  it("L2: guesses at MCP_SERVICE_SECRET are limited per address before the secret is compared; a weak secret is refused at startup", async () => {
    const t = await connect(ownerBrowser, { clientId: CIMD, redirectUri: CIMD_REDIRECT });
    const asMcp = (secret: string) => viaProxy(async () => apiApp.request("/v1/me", { headers: { Authorization: `Bearer ${t.access_token}`, [SERVICE_HEADER]: secret,
      "X-Hlcrm-Surface": "ops-mcp", ...from("203.0.113.60") } }));
    expect((await asMcp(s().serviceSecret)).status).toBe(200);
    for (let i = 0; i < 30; i++) expect((await asMcp(randomBytes(32).toString("base64url"))).status).toBe(401);
    // Blocked: even the right secret is not compared from this address for a while.
    expect((await asMcp(s().serviceSecret)).status).toBe(429);
    // The MCP process's own address is unaffected.
    expect((await mcpModern("ops", t.access_token, "tools/list")).status).toBe(200);
    expect(randomEnough("abcdefgh".repeat(5))).toBe(false);
    expect(randomEnough(randomBytes(32).toString("base64url"))).toBe(true);
    expect(randomEnough(randomBytes(32).toString("hex"))).toBe(true);
  });

  it("L3: a token the API refuses loses its pass past the MCP limiter at once", async () => {
    const t = await connect(ownerBrowser, { clientId: CIMD, redirectUri: CIMD_REDIRECT });
    expect((await mcpModern("ops", t.access_token, "tools/list")).status).toBe(200);
    await apiApp.request("/oauth/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: t.access_token, client_id: CIMD }).toString() });
    expect((await mcpModern("ops", t.access_token, "tools/list")).status).toBe(401);
    for (let i = 0; i < 30; i++) await mcpModern("ops", `hlcrm_oat_${randomBytes(32).toString("base64url")}`, "tools/list");
    expect((await mcpModern("ops", t.access_token, "tools/list")).status).toBe(429);
  });
});

describe("consent and scope consistency", () => {
  it("L6a: a document whose redirect goes to another site gets a plain warning, and the receiving site is the prominent one", async () => {
    const id = "https://lookalike.example/client.json";
    serve(id, { client_id: id, client_name: "Claude", redirect_uris: ["https://third.example/cb"] });
    const page = await ownerBrowser.request("GET", authorizePath({ clientId: id, redirectUri: "https://third.example/cb" }, pkce().challenge));
    expect(page.status).toBe(200);
    expect(page.text).toContain("Access would be sent to <strong>third.example</strong>");
    expect(page.text).toContain("access would be sent to a different site");
    const same = await ownerBrowser.request("GET", authorizePath({ clientId: CIMD, redirectUri: CIMD_REDIRECT }, pkce().challenge));
    expect(same.text).not.toContain("different site");
  });

  it("L6b, L6c: the workspace's allowed scopes follow the hierarchy, and a refresh reports the scopes that apply now", async () => {
    const t = await connect(ownerBrowser, { clientId: CIMD, redirectUri: CIMD_REDIRECT, scope: "ops:read ops:write" });
    expect((await call("PATCH", "/v1/workspace/sign-in", { key: ws.keys.admin, body: { oauth_scopes: ["ops:write"] } })).status).toBe(200);
    try {
      // ops:write allowed means ops:read allowed.
      const page = await ownerBrowser.request("GET", authorizePath({ clientId: CIMD, redirectUri: CIMD_REDIRECT, scope: "ops:read" }, pkce().challenge));
      expect(page.text).toContain('value="approve"');
      expect(page.text).not.toContain("doesn&#39;t let apps have it");
      expect((await call("PATCH", "/v1/workspace/sign-in", { key: ws.keys.admin, body: { oauth_scopes: ["ops:read"] } })).status).toBe(200);
      const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CIMD });
      expect(r.status).toBe(200);
      expect(r.json.scope).toBe("ops:read");
    } finally {
      await call("PATCH", "/v1/workspace/sign-in", { key: ws.keys.admin, body: { oauth_scopes: ["ops:read", "ops:write", "restricted:read", "admin"] } });
    }
  });
});

describe("settings", () => {
  it("OAuth is off without MCP_PUBLIC_URL, and a half-configured server refuses to start", async () => {
    const saved = { url: process.env.MCP_PUBLIC_URL, secret: process.env.MCP_SERVICE_SECRET };
    try {
      for (const [url, secret, why] of [["http://mcp.example.com", saved.secret, /https/], ["https://mcp.example.com/mcp", saved.secret, /origin only/],
        ["https://mcp.example.com", undefined, /MCP_SERVICE_SECRET/], ["https://mcp.example.com", "change-me", /MCP_SERVICE_SECRET/],
        ["https://mcp.example.com", "a".repeat(40), /MCP_SERVICE_SECRET/], ["https://mcp.example.com", "abcdefgh".repeat(5), /openssl rand/],
        ["https://mcp.example.com", "abcdefghijklmnopq".repeat(2), /MCP_SERVICE_SECRET/]] as const) {
        process.env.MCP_PUBLIC_URL = url;
        if (secret === undefined) delete process.env.MCP_SERVICE_SECRET;
        else process.env.MCP_SERVICE_SECRET = secret;
        resetConfig();
        expect(() => assertStartupConfig("api"), url).toThrow(why);
        expect(() => assertStartupConfig("mcp"), url).toThrow(why);
      }
      delete process.env.MCP_PUBLIC_URL;
      resetConfig();
      expect(oauthSettings()).toBeNull();
      for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp/ops"]) expect((await apiApp.request(path)).status).toBe(404);
      expect((await tokenRequest({ grant_type: "refresh_token" })).status).toBe(404);
      expect((await ownerBrowser.request("GET", "/oauth/authorize?client_id=x")).status).toBe(404);
      // The MCP process without OAuth answers as before, and refuses an OAuth-shaped token outright.
      const plain = buildMcpApp({ apiUrl: "http://api.local", fetch: apiFetch });
      const res = await plain.request("https://mcp.test/mcp/ops", { method: "POST", headers: { Authorization: `Bearer hlcrm_oat_${"a".repeat(43)}` }, body: "{}" });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="hl-crm-db"');
    } finally {
      process.env.MCP_PUBLIC_URL = saved.url;
      process.env.MCP_SERVICE_SECRET = saved.secret;
      resetConfig();
    }
  });
});

describe("no token, code or verifier is stored or logged in the clear", () => {
  it("scans the OAuth tables, the audit log, idempotency records and the captured logs", async () => {
    expect(secrets.size).toBeGreaterThan(20);
    const dump = await owner.begin(async (tx) => {
      const out: string[] = [];
      for (const t of ["oauth_clients", "oauth_codes", "oauth_grants", "oauth_tokens", "oauth_assertions", "audit_log", "idempotency_keys", "sessions"]) {
        // The owner is bound by FORCE ROW LEVEL SECURITY too; lift it inside this transaction only, which is rolled back.
        await tx.unsafe(`ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY`);
        out.push(JSON.stringify(await tx.unsafe(`SELECT * FROM ${t}`)));
      }
      throw Object.assign(new Error("rollback"), { out });
    }).catch((e: { out?: string[] }) => e.out!.join("\n"));
    expect(dump.length).toBeGreaterThan(1000);
    const leaks = [...secrets].filter((x) => dump.includes(x) || logged.some((l) => l.includes(x)));
    expect(leaks).toEqual([]);
    expect(logged.join("\n")).not.toMatch(/hlcrm_o(at|rt|ac)_[A-Za-z0-9_-]{43}/);
  });
});
