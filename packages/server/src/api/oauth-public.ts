import type { Context, Hono } from "hono";
import { oauthSettings } from "../config.js";
import { LIMITS, addressKey, hit, peek } from "../auth/limits.js";
import { logger } from "../lib/logger.js";
import { ClientError, redirectHost, registerClient } from "../oauth/clients.js";
import { authorizationServerMetadata, protectedResourceMetadata } from "../oauth/metadata.js";
import { RESOURCES } from "../oauth/scopes.js";
import { TokenError, authenticateClient, exchangeCode, refresh, revokeToken, type Meta } from "../oauth/token.js";
import { clientAddress, type Env } from "./app.js";

/**
 * The machine-facing half of the OAuth authorization server (ADR 0010): discovery documents, the
 * token, revocation and registration endpoints. None takes a session or an API key; each is listed in
 * PUBLIC_AUTH_ROUTES (api/auth-public.ts). The browser-facing authorization endpoint is web/oauth.ts.
 * Everything here answers 404 while OAuth is off (MCP_PUBLIC_URL unset).
 *
 * These endpoints use no cookies, so they allow any origin (CORS), for MCP clients that run in a browser.
 */

type C = Context<Env>;

const oauthError = (c: C, status: number, error: string, description: string) =>
  c.json({ error, error_description: description }, status as 400, { "Cache-Control": "no-store", Pragma: "no-cache" });

/** Logs, at most once a window, that registrations server-wide passed what this server expects: an alarm, never a refusal. */
let registrationAlarmUntil = 0;

const limited = (c: C, seconds: number) => {
  c.header("Retry-After", String(seconds));
  return oauthError(c, 429, "slow_down", "Too many requests; wait and retry");
};

/** A form body as single values. A parameter sent twice is refused (RFC 6749 §3.2), and so is anything that isn't a form. */
async function formFields(c: C): Promise<Record<string, string> | string> {
  if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return "Send the request as application/x-www-form-urlencoded";
  const text = await c.req.text();
  if (text.length > 64 * 1024) return "The request is too large";
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(text)) {
    if (Object.hasOwn(out, k)) return `${k} was sent more than once`;
    if (v.includes("\0") || v.length > 8192) return `${k} is not valid`;
    out[k] = v;
  }
  return out;
}

export function mountOAuth(app: Hono<Env>): void {
  const on = () => oauthSettings();
  const off = (c: C) => c.json({ error: "not_found", error_description: "OAuth for MCP is off on this server (MCP_PUBLIC_URL is not set)" }, 404);

  app.use("/.well-known/*", async (c, next) => {
    await next();
    c.header("Access-Control-Allow-Origin", "*");
  });
  app.use("/oauth/*", async (c, next) => {
    // The authorization endpoint is a page for people; the rest are for clients, from anywhere.
    if (c.req.path !== "/oauth/authorize") {
      c.header("Access-Control-Allow-Origin", "*");
      if (c.req.method === "OPTIONS") {
        c.header("Access-Control-Allow-Methods", "POST");
        c.header("Access-Control-Allow-Headers", "Content-Type");
        c.header("Access-Control-Max-Age", "600");
        return c.body(null, 204);
      }
    }
    await next();
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    c.header("Referrer-Policy", "no-referrer");
  });

  const asMetadata = (c: C) => {
    const s = on();
    return s ? c.json(authorizationServerMetadata(s.issuer)) : off(c);
  };
  app.get("/.well-known/oauth-authorization-server", asMetadata);
  app.get("/.well-known/openid-configuration", asMetadata);
  // Served here too, so one origin in front of both processes works whichever one a proxy routes this path to.
  for (const name of RESOURCES) {
    app.get(`/.well-known/oauth-protected-resource/mcp/${name}`, (c) => {
      const s = on();
      return s ? c.json(protectedResourceMetadata(s.resources[name], s.issuer, name)) : off(c);
    });
  }

  /**
   * Limits, in order: per address (600 a minute) before anything; then requests that prove nothing
   * (unknown client, no such code or refresh token) per client_id and address, so naming a public
   * client's ID can't use up what its real users need; and only once a code or refresh token is found
   * (oauth/token.ts chargeProven), per client and workspace.
   */
  app.post("/oauth/token", async (c) => {
    if (!on()) return off(c);
    const addr = clientAddress(c);
    const caller = addressKey(addr);
    const wait = hit(LIMITS.oauthToken, caller);
    if (wait !== null) return limited(c, wait);
    const f = await formFields(c);
    if (typeof f === "string") return oauthError(c, 400, "invalid_request", f);
    const unproven = `${(f.client_id ?? "").slice(0, 500)}|${caller}`;
    const failing = peek(LIMITS.oauthTokenUnproven, unproven);
    if (failing !== null) return limited(c, failing);
    const meta: Meta = { requestId: c.get("requestId"), address: addr, caller };
    try {
      const client = await authenticateClient(f, c.req.header("authorization"), meta);
      if (f.grant_type === "authorization_code") return c.json(await exchangeCode(client, f, meta), 200, { "Cache-Control": "no-store", Pragma: "no-cache" });
      if (f.grant_type === "refresh_token") return c.json(await refresh(client, f, meta), 200, { "Cache-Control": "no-store", Pragma: "no-cache" });
      return oauthError(c, 400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    } catch (e) {
      if (!(e instanceof TokenError)) throw e;
      logger.info({ requestId: meta.requestId, event: "oauth_token_refused", error: e.code }, "token request refused");
      if (e.retryAfter !== undefined) return limited(c, e.retryAfter);
      if (e.status === 401) c.header("WWW-Authenticate", 'Bearer realm="hl-crm-db"');
      return oauthError(c, e.status, e.code, e.message);
    } finally {
      if (!meta.proven) hit(LIMITS.oauthTokenUnproven, unproven);
    }
  });

  app.post("/oauth/revoke", async (c) => {
    if (!on()) return off(c);
    const addr = clientAddress(c);
    const caller = addressKey(addr);
    const wait = hit(LIMITS.oauthRevoke, caller);
    if (wait !== null) return limited(c, wait);
    const f = await formFields(c);
    if (typeof f === "string") return oauthError(c, 400, "invalid_request", f);
    try {
      const meta: Meta = { requestId: c.get("requestId"), address: addr, caller };
      const client = await authenticateClient(f, c.req.header("authorization"), meta);
      await revokeToken(client, f, meta);
      return c.body(null, 200);
    } catch (e) {
      if (!(e instanceof TokenError)) throw e;
      return oauthError(c, e.status, e.code, e.message);
    }
  });

  app.post("/oauth/register", async (c) => {
    if (!on()) return off(c);
    const addr = clientAddress(c);
    // Per address (an IPv6 /64) and per IPv6 /48. The server-wide figure only raises an alarm: refusing past it would let a few addresses stop every new connection.
    const wait = hit(LIMITS.oauthRegister, addressKey(addr)) ?? (addressKey(addr, 48) !== addressKey(addr) ? hit(LIMITS.oauthRegisterNet, addressKey(addr, 48)) : null);
    if (wait !== null) return limited(c, wait);
    if (hit(LIMITS.oauthRegisterAll, "all") !== null && Date.now() > registrationAlarmUntil) {
      registrationAlarmUntil = Date.now() + LIMITS.oauthRegisterAll.windowMs;
      logger.error({ event: "oauth_registration_surge", per_hour: LIMITS.oauthRegisterAll.max }, "client registrations server-wide passed the expected hourly figure; still accepting them");
    }
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) return oauthError(c, 400, "invalid_client_metadata", "Send the registration as JSON");
    let body: unknown;
    try {
      const text = await c.req.text();
      if (text.length > 16 * 1024) return oauthError(c, 400, "invalid_client_metadata", "The registration is larger than 16 KB");
      body = JSON.parse(text);
    } catch {
      return oauthError(c, 400, "invalid_client_metadata", "The body is not JSON");
    }
    try {
      const client = await registerClient(body);
      // No workspace is known yet, so this is logged rather than audited; consent entries name the client later.
      logger.info({ requestId: c.get("requestId"), event: "oauth_client_registered", client_id: client.clientId, redirect_hosts: client.redirectUris.map(redirectHost),
        application_type: client.applicationType, ip: addr }, "oauth client registered");
      return c.json({
        client_id: client.clientId, client_id_issued_at: Math.floor(client.issuedAt.getTime() / 1000), client_name: client.name,
        ...(client.clientUri ? { client_uri: client.clientUri } : {}), redirect_uris: client.redirectUris, application_type: client.applicationType,
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
      }, 201, { "Cache-Control": "no-store", Pragma: "no-cache" });
    } catch (e) {
      if (!(e instanceof ClientError)) throw e;
      return oauthError(c, e.code === "temporarily_unavailable" ? 503 : 400, e.code, e.message);
    }
  });
}
