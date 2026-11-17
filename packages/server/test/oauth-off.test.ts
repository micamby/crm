import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetAuthLimiter } from "../src/api/app.js";
import { resetSignInLimits } from "../src/auth/limits.js";
import { assertStartupConfig, oauthSettings, resetConfig } from "../src/config.js";
import { buildMcpApp, resetMcpLimiter } from "../src/mcp/http.js";
import { SERVICE_HEADER } from "../src/oauth/scopes.js";
import { app as apiApp, Browser, call, create, newWorkspace, signedIn, type Workspace } from "./helpers.js";

/**
 * OAuth for MCP switched off (MCP_PUBLIC_URL and MCP_SERVICE_SECRET absent), the configuration most
 * self-hosted servers start in. test/env.ts turns OAuth on for every other suite; this one takes it
 * away again and checks nothing of it is left reachable, while keys, sign-in and sessions work as before.
 */

const saved = { url: process.env.MCP_PUBLIC_URL, secret: process.env.MCP_SERVICE_SECRET };
const apiFetch: typeof fetch = async (input, init) => apiApp.request(input instanceof Request ? input : String(input), init);
const oauthShaped = () => `hlcrm_oat_${randomBytes(32).toString("base64url")}`;
let ws: Workspace;

beforeAll(async () => {
  delete process.env.MCP_PUBLIC_URL;
  delete process.env.MCP_SERVICE_SECRET;
  resetConfig();
  ws = await newWorkspace("OAuth off");
});
afterAll(() => {
  process.env.MCP_PUBLIC_URL = saved.url;
  process.env.MCP_SERVICE_SECRET = saved.secret;
  resetConfig();
});
beforeEach(() => {
  resetSignInLimits();
  resetAuthLimiter();
  resetMcpLimiter();
});

describe("OAuth for MCP off", () => {
  it("both processes start, and every OAuth endpoint and discovery document answers 404", async () => {
    expect(oauthSettings()).toBeNull();
    expect(() => assertStartupConfig("api")).not.toThrow();
    expect(() => assertStartupConfig("mcp")).not.toThrow();
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration", "/.well-known/oauth-protected-resource/mcp/ops",
      "/.well-known/oauth-protected-resource/mcp/admin", "/oauth/authorize?client_id=x"]) {
      expect((await apiApp.request(path)).status, path).toBe(404);
    }
    for (const [path, type, body] of [["/oauth/token", "application/x-www-form-urlencoded", "grant_type=refresh_token"], ["/oauth/revoke", "application/x-www-form-urlencoded", "token=x"],
      ["/oauth/register", "application/json", JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] })]] as const) {
      expect((await apiApp.request(path, { method: "POST", headers: { "Content-Type": type }, body })).status, path).toBe(404);
    }
  });

  it("the REST API refuses an OAuth-shaped bearer, even with a service secret header", async () => {
    for (const headers of [{}, { [SERVICE_HEADER]: randomBytes(32).toString("base64url"), "X-Hlcrm-Surface": "ops-mcp" }] as Record<string, string>[]) {
      const r = await apiApp.request("/v1/me", { headers: { Authorization: `Bearer ${oauthShaped()}`, ...headers } });
      expect(r.status).toBe(401);
    }
    expect((await call("GET", "/v1/me", { key: ws.keys.ops })).status).toBe(200);
  });

  it("the MCP process refuses OAuth-shaped tokens with a plain challenge and still takes API keys", async () => {
    const mcp = buildMcpApp({ apiUrl: "http://api.local", fetch: apiFetch, oauth: oauthSettings() });
    const res = await mcp.request("https://mcp.test/mcp/ops", { method: "POST", headers: { Authorization: `Bearer ${oauthShaped()}`, "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="hl-crm-db"');
    expect((await mcp.request("https://mcp.test/.well-known/oauth-protected-resource/mcp/ops")).status).toBe(404);
    const client = new Client({ name: "oauth-off", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("https://mcp.test/mcp/ops"), {
      fetch: (async (input, init) => mcp.request(input instanceof Request ? input : String(input), init)) as typeof fetch,
      requestInit: { headers: { Authorization: `Bearer ${ws.keys.ops}` } },
    }));
    expect((await client.listTools()).tools.length).toBeGreaterThan(5);
    await client.close();
  });

  it("people still sign in and use sessions", async () => {
    const b = await signedIn(ws.ownerEmail, undefined, new Browser());
    const session = await b.request("GET", "/v1/auth/session");
    expect(session.status).toBe(200);
    expect(session.json.session.id).toBeTruthy();
    // The app learns that connecting apps is off from the session, instead of probing the discovery document (a 404 here).
    expect(session.json.server).toEqual({ connected_apps: false });
    // The connected-apps page and list still answer (empty) rather than failing.
    expect((await b.request("GET", "/v1/auth/apps")).json.data).toEqual([]);
  });

  it("the read and write sides work as before: through the API with a key and a session, and through MCP with a key (merge dry run, token, run)", async () => {
    const tag = `off${Date.now()}`;
    const survivor = await create(ws.keys.ops, "contact", { first_name: "Off", last_name: "B", email: `s-${tag}@off.example`, job_title: tag });
    const dup = await create(ws.keys.ops, "contact", { first_name: "Off", last_name: "A", email: `d-${tag}@off.example`, job_title: tag });
    const where = { field: "job_title", op: "eq", value: tag };
    const listed = await call("POST", "/v1/query", { key: ws.keys.ops, body: { object: "contact", where, count: true, sort: [{ field: "first_name" }, { field: "last_name" }] } });
    expect(listed.json.total).toBe(2);
    expect(listed.json.data.map((r: { last_name: string }) => r.last_name)).toEqual(["A", "B"]);
    const b = await signedIn(ws.ownerEmail, undefined, new Browser());
    expect((await b.request("POST", "/v1/aggregate", { body: { object: "contact", where, group_by: [{ field: "first_name" }] } })).json.data[0].count).toBe(2);
    expect((await b.request("GET", "/v1/workspace")).json.data.sign_in).toMatchObject({ oauth_apps: expect.any(Boolean) });
    // Connected-app lists answer, empty.
    expect((await call("GET", "/v1/apps", { key: ws.keys.admin })).json.data).toEqual([]);

    const mcp = buildMcpApp({ apiUrl: "http://api.local", fetch: apiFetch, oauth: oauthSettings() });
    const client = new Client({ name: "oauth-off-writes", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("https://mcp.test/mcp/ops"), {
      fetch: (async (input, init) => mcp.request(input instanceof Request ? input : String(input), init)) as typeof fetch,
      requestInit: { headers: { Authorization: `Bearer ${ws.keys.ops}` } },
    }));
    const result = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
      expect(r.isError, r.content[0]!.text).toBeFalsy();
      return JSON.parse(r.content[0]!.text).result;
    };
    const dry = await result("merge_records", { survivor: survivor.id, duplicates: [dup.id] });
    const merged = await result("merge_records", { survivor: survivor.id, duplicates: [dup.id], dry_run: false, confirm: true, confirm_token: dry.confirm_token });
    expect(merged.merged).toEqual([dup.id]);
    expect((await result("get_record", { id: dup.id })).merged_into).toBe(survivor.id);
    await client.close();
  });

  it("a half-configured server refuses to start", () => {
    const pub = process.env.PUBLIC_URL;
    try {
      for (const [url, secret, publicUrl] of [["https://mcp.example.com", undefined, pub], ["https://mcp.example.com", "abcdefgh".repeat(5), pub],
        ["https://mcp.example.com", randomBytes(32).toString("base64url"), undefined]] as const) {
        process.env.MCP_PUBLIC_URL = url;
        if (secret === undefined) delete process.env.MCP_SERVICE_SECRET;
        else process.env.MCP_SERVICE_SECRET = secret;
        if (publicUrl === undefined) delete process.env.PUBLIC_URL;
        else process.env.PUBLIC_URL = publicUrl;
        resetConfig();
        expect(() => assertStartupConfig("api")).toThrow(/MCP_SERVICE_SECRET|PUBLIC_URL/);
        expect(() => assertStartupConfig("mcp")).toThrow(/MCP_SERVICE_SECRET|PUBLIC_URL/);
      }
    } finally {
      delete process.env.MCP_PUBLIC_URL;
      delete process.env.MCP_SERVICE_SECRET;
      process.env.PUBLIC_URL = pub;
      resetConfig();
    }
  });
});
