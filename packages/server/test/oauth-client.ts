import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect } from "vitest";
import { oauthSettings } from "../src/config.js";
import { buildMcpApp } from "../src/mcp/http.js";
import { SERVICE_HEADER } from "../src/oauth/scopes.js";
import { app as apiApp, type Browser } from "./helpers.js";

/**
 * A small OAuth client for suites other than test/oauth.test.ts (which has its own, with metadata-document
 * clients and every refusal): a registered client, authorize and consent in a signed-in browser, the code
 * exchanged for tokens, and MCP calls through the in-process MCP app, which presents the token to the API
 * with MCP_SERVICE_SECRET as the real MCP process does.
 */

const s = () => oauthSettings()!;
const apiFetch: typeof fetch = async (input, init) => apiApp.request(input instanceof Request ? input : String(input), init);
export const mcpApp = buildMcpApp({ apiUrl: "http://api.local", fetch: apiFetch, oauth: oauthSettings() });
const mcpFetch: typeof fetch = async (input, init) => mcpApp.request(input instanceof Request ? input : String(input), init);

export type Resource = "ops" | "admin";
export interface Tokens { access_token: string; refresh_token: string; scope: string }

/** Registers a client (RFC 7591) with a web redirect URI; returns its client ID. */
export async function registerClient(name: string, redirectUri = "https://claude.ai/api/mcp/auth_callback"): Promise<{ clientId: string; redirectUri: string }> {
  const res = await apiApp.request("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: name, redirect_uris: [redirectUri], application_type: "web" }) });
  const json = await res.json() as { client_id: string };
  expect(res.status, JSON.stringify(json)).toBe(201);
  return { clientId: json.client_id, redirectUri };
}

/** Hidden fields of the consent form, unescaped. */
function hiddenFields(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)) {
    out[m[1]!.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))] = m[2]!.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  }
  return out;
}

/** Authorizes, approves in `browser`, and exchanges the code: one connection (grant) of the browser's member. */
export async function connectApp(browser: Browser, client: { clientId: string; redirectUri: string }, resource: Resource, scope: string): Promise<Tokens> {
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({ response_type: "code", client_id: client.clientId, redirect_uri: client.redirectUri, scope, resource: s().resources[resource],
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "st" });
  const page = await browser.request("GET", `/oauth/authorize?${q}`);
  expect(page.status, page.text).toBe(200);
  const approved = await browser.request("POST", "/oauth/authorize", { form: { ...hiddenFields(page.text), decision: "approve" } });
  expect(approved.status, approved.text).toBe(303);
  const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
  const res = await apiApp.request("/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: client.redirectUri, client_id: client.clientId,
      resource: s().resources[resource] }).toString() });
  const json = await res.json() as Tokens;
  expect(res.status, JSON.stringify(json)).toBe(200);
  return json;
}

/** An MCP client (2025-11-25, through the SDK) on one endpoint with a bearer (an access token or an API key). */
export async function mcpClient(resource: Resource, bearer: string): Promise<Client> {
  const client = new Client({ name: "oauth-combined", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`https://mcp.test/mcp/${resource}`), {
    fetch: mcpFetch, requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  }));
  return client;
}

export interface ToolOutcome { isError: boolean; text: string; result: unknown; meta?: Record<string, unknown> }

/** Calls a tool and returns its outcome: the parsed `result` on success, the error text otherwise. */
export async function tool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[]; _meta?: Record<string, unknown> };
  const text = r.content[0]!.text;
  return { isError: Boolean(r.isError), text, result: r.isError ? undefined : (JSON.parse(text) as { result: unknown }).result, meta: r._meta };
}

/**
 * A request to the API as the MCP process makes it for an OAuth connection: the token, the service secret
 * and the endpoint's surface. For routes no tool covers (preferences), and to show what the API itself decides.
 */
export async function asMcpProcess(token: string, resource: Resource, method: string, path: string, body?: unknown) {
  const res = await apiApp.request(path, { method, headers: { Authorization: `Bearer ${token}`, [SERVICE_HEADER]: s().serviceSecret,
    "X-Hlcrm-Surface": `${resource}-mcp`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined };
}
