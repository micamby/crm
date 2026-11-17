import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../src/lib/logger.js";
import { resetAuthLimiter } from "../src/api/app.js";
import { resetSignInLimits } from "../src/auth/limits.js";
import { resetOidcCache } from "../src/auth/oidc.js";
import { resetConfig } from "../src/config.js";
import { app, Browser, call, memberWithKey, newWorkspace, uniqueEmail, type Workspace } from "./helpers.js";
import { withTenant } from "../src/db/tx.js";
import { decodeId } from "../src/lib/ids.js";

/**
 * Single sign-on against a fake OpenID Connect provider run in-process on 127.0.0.1 (discovery, keys,
 * token endpoint with PKCE checks). Every ID token check is made to fail once.
 */

const CLIENT_ID = "hlcrm-test-client";
const CLIENT_SECRET = "test-client-secret-value";

interface Grant { challenge: string; nonce: string; redirectUri: string; claims: Record<string, unknown> }

class FakeProvider {
  server!: Server;
  issuer = "";
  key!: { privateKey: CryptoKey; publicKey: CryptoKey };
  kid = "k1";
  published: JWK[] = [];
  grants = new Map<string, Grant>();
  /** Overrides for the next ID token. */
  tamper: { claims?: Record<string, unknown>; key?: CryptoKey; kid?: string; issuerInDoc?: string } = {};
  /** The authorization endpoint the discovery document names; by default on the issuer's origin. */
  authEndpoint = "";
  tokenRequests: URLSearchParams[] = [];
  jwksFetches = 0;

  async start() {
    this.key = await generateKeyPair("RS256");
    this.published = [{ ...(await exportJWK(this.key.publicKey)), kid: this.kid, alg: "RS256", use: "sig" }];
    this.server = createServer((req, res) => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const url = new URL(req.url!, this.issuer);
      if (url.pathname === "/.well-known/openid-configuration") {
        return send(200, { issuer: this.tamper.issuerInDoc ?? this.issuer, authorization_endpoint: this.authEndpoint || `${this.issuer}/authorize`,
          token_endpoint: `${this.issuer}/token`, jwks_uri: `${this.issuer}/jwks` });
      }
      if (url.pathname === "/jwks") {
        this.jwksFetches++;
        return send(200, { keys: this.published });
      }
      if (url.pathname === "/token" && req.method === "POST") {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", async () => {
          const form = new URLSearchParams(raw);
          this.tokenRequests.push(form);
          const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
          if (req.headers.authorization !== `Basic ${basic}`) return send(401, { error: "invalid_client" });
          const g = this.grants.get(form.get("code") ?? "");
          this.grants.delete(form.get("code") ?? "");
          const verifier = form.get("code_verifier") ?? "";
          if (!g || g.redirectUri !== form.get("redirect_uri") || createHash("sha256").update(verifier).digest("base64url") !== g.challenge) {
            return send(400, { error: "invalid_grant" });
          }
          const now = Math.floor(Date.now() / 1000);
          const claims = { iss: this.issuer, aud: CLIENT_ID, iat: now, exp: now + 300, nonce: g.nonce, ...g.claims, ...this.tamper.claims };
          const jwt = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: this.tamper.kid ?? this.kid }).sign(this.tamper.key ?? this.key.privateKey);
          send(200, { access_token: "at", token_type: "Bearer", id_token: jwt });
        });
        return;
      }
      send(404, { error: "not_found" });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.issuer = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  /** What the authorization endpoint does after the person approves: a code bound to the PKCE challenge and nonce. */
  authorize(redirectUrl: string, claims: Record<string, unknown>): { code: string; state: string } {
    const u = new URL(redirectUrl);
    expect(u.origin + u.pathname).toBe(this.authEndpoint || `${this.issuer}/authorize`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: "code", client_id: CLIENT_ID, redirect_uri: "https://crm.test/auth/sso/callback",
      scope: "openid email profile", code_challenge_method: "S256" });
    const code = `code-${Math.random().toString(36).slice(2)}`;
    this.grants.set(code, { challenge: u.searchParams.get("code_challenge")!, nonce: u.searchParams.get("nonce")!, redirectUri: u.searchParams.get("redirect_uri")!, claims });
    return { code, state: u.searchParams.get("state")! };
  }
}

const idp = new FakeProvider();
let ws: Workspace;

beforeAll(async () => {
  await idp.start();
  Object.assign(process.env, { OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: CLIENT_ID, OIDC_CLIENT_SECRET: CLIENT_SECRET, OIDC_DISPLAY_NAME: "Test IdP",
    OIDC_ALLOW_INSECURE_ISSUER: "true" });
  resetConfig();
  resetOidcCache();
  ws = await newWorkspace("SSO");
});
afterAll(async () => {
  for (const k of ["OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_DISPLAY_NAME", "OIDC_ALLOW_INSECURE_ISSUER", "OIDC_ALLOWED_DOMAINS"]) delete process.env[k];
  resetConfig();
  resetOidcCache();
  await new Promise((r) => idp.server.close(r));
});
beforeEach(() => {
  idp.tamper = {};
  resetSignInLimits();
  resetAuthLimiter();
});

async function addMember(email = uniqueEmail("sso")) {
  const r = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email, name: "SSO person", role: "member" } });
  return { id: r.json.data.id as string, email };
}

/** Runs the whole flow in one browser and returns the callback's response. */
async function sso(claims: Record<string, unknown>, opts: { state?: (s: string) => string; browser?: Browser } = {}) {
  const b = opts.browser ?? new Browser();
  const start = await b.request("POST", "/auth/sso", { body: { return_to: "/after" } });
  expect(start.status).toBe(200);
  const { code, state } = idp.authorize(start.json.redirect_url, claims);
  const cb = await b.request("GET", `/auth/sso/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(opts.state ? opts.state(state) : state)}`);
  return { b, cb, code, state };
}

const refused = (cb: { status: number; headers: Headers; setCookies: string[] }) => {
  expect(cb.status).toBe(303);
  expect(cb.headers.get("location")).toBe("/auth/error?error=sign_in_failed");
  expect(cb.setCookies.some((c) => c.startsWith("__Host-hlcrm_session=") && !c.includes("Max-Age=0"))).toBe(false);
};

describe("single sign-on", () => {
  it("is offered by the capabilities endpoint and the sign-in page, which lets its form reach the provider", async () => {
    const cap = await (await app.request("/auth/capabilities")).json();
    expect(cap.methods.sso).toEqual({ name: "Test IdP", start: "/auth/sso" });
    const page = await new Browser().request("GET", "/auth/sign-in");
    expect(page.text).toContain("Sign in with Test IdP");
    expect(page.headers.get("content-security-policy")).toContain(`form-action 'self' ${idp.issuer}`);
  });

  it("signs in an existing member by verified email with PKCE, links the subject, and prefers the subject afterwards", async () => {
    const m = await addMember();
    const sub = `sub-${Date.now()}`;
    const { b, cb } = await sso({ sub, email: m.email, email_verified: true });
    expect(cb.status).toBe(303);
    expect(cb.headers.get("location")).toBe("/after");
    expect((await b.request("GET", "/v1/auth/session")).json).toMatchObject({ session: { method: "oidc" }, member: { id: m.id } });
    // The token request carried the PKCE verifier and the exact redirect URI.
    const req = idp.tokenRequests.at(-1)!;
    expect(req.get("grant_type")).toBe("authorization_code");
    expect(req.get("redirect_uri")).toBe("https://crm.test/auth/sso/callback");
    const listed = (await call("GET", "/v1/members", { key: ws.keys.admin })).json.data.users.find((u: { id: string }) => u.id === m.id);
    expect(listed.sign_in).toMatchObject({ sso_linked: true });
    const log = await call("GET", "/v1/audit-log?action=auth.sso_linked", { key: ws.keys.admin });
    expect(log.json.data[0]).toMatchObject({ details: { issuer: idp.issuer } });

    // The provider now reports another member's email for the same subject: the linked member signs in, not the other one.
    const other = await addMember();
    const again = await sso({ sub, email: other.email, email_verified: true });
    expect((await again.b.request("GET", "/v1/auth/session")).json.member.id).toBe(m.id);
    // A different subject claiming the linked member's email is refused: that member is linked to someone else.
    refused((await sso({ sub: `${sub}-impostor`, email: m.email, email_verified: true })).cb);
  });

  it("never creates a member, and honours the allowed email domains", async () => {
    refused((await sso({ sub: "nobody", email: uniqueEmail("stranger"), email_verified: true })).cb);
    const m = await addMember();
    process.env.OIDC_ALLOWED_DOMAINS = "only.example";
    resetConfig();
    try {
      refused((await sso({ sub: `d-${Date.now()}`, email: m.email, email_verified: true })).cb);
    } finally {
      delete process.env.OIDC_ALLOWED_DOMAINS;
      resetConfig();
    }
  });

  it("refuses each ID token problem: issuer, audience, azp, nonce, signature, expiry, unverified email; and a state mismatch", async () => {
    const m = await addMember();
    const now = Math.floor(Date.now() / 1000);
    const base = { sub: `v-${Date.now()}`, email: m.email, email_verified: true };
    const other = await generateKeyPair("RS256");
    // The person sees one generic message; the log says which check failed.
    const reasons: string[] = [];
    const spy = vi.spyOn(logger, "warn").mockImplementation(((o: { event?: string; reason?: string }) => {
      if (o?.event === "sso_failed") reasons.push(o.reason!);
    }) as never);
    const cases: [string, () => void, Record<string, unknown>, string][] = [
      ["wrong issuer", () => { idp.tamper = { claims: { iss: "https://evil.example" } }; }, base, "id_token"],
      ["wrong audience", () => { idp.tamper = { claims: { aud: "someone-else" } }; }, base, "id_token"],
      ["several audiences without azp", () => { idp.tamper = { claims: { aud: [CLIENT_ID, "other"] } }; }, base, "azp_missing"],
      ["wrong azp", () => { idp.tamper = { claims: { azp: "someone-else" } }; }, base, "azp"],
      ["wrong nonce", () => { idp.tamper = { claims: { nonce: "not-the-nonce" } }; }, base, "nonce"],
      ["bad signature", () => { idp.tamper = { key: other.privateKey }; }, base, "id_token"],
      ["expired", () => { idp.tamper = { claims: { exp: now - 600, iat: now - 1200 } }; }, base, "id_token"],
      ["email not verified", () => {}, { ...base, email_verified: false }, "email_unverified"],
      ["email_verified as a string", () => {}, { ...base, email_verified: "true" }, "email_unverified"],
    ];
    try {
      for (const [what, setup, claims, reason] of cases) {
        idp.tamper = {};
        setup();
        reasons.length = 0;
        const { cb } = await sso(claims);
        expect(cb.headers.get("location"), what).toBe("/auth/error?error=sign_in_failed");
        refused(cb);
        expect(reasons, what).toEqual([reason]);
      }
      idp.tamper = {};
      reasons.length = 0;
      const { cb } = await sso(base, { state: (s) => `${s}x` });
      refused(cb);
      expect(reasons).toEqual(["state"]);
    } finally {
      spy.mockRestore();
    }
    // The flow was used up by that failed attempt, so the right state can't be replayed after it.
    const { b, cb: ok } = await sso(base);
    expect(ok.headers.get("location")).toBe("/after");
    const replay = await b.request("GET", `/auth/sso/callback?code=x&state=y`);
    expect(replay.headers.get("location")).toBe("/auth/error?error=expired");
  });

  it("refuses a callback in a browser that didn't start the flow, and a provider error", async () => {
    const m = await addMember();
    const b = new Browser();
    const start = await b.request("POST", "/auth/sso", { body: {} });
    const { code, state } = idp.authorize(start.json.redirect_url, { sub: "x", email: m.email, email_verified: true });
    const elsewhere = await new Browser().request("GET", `/auth/sso/callback?code=${code}&state=${state}`);
    expect(elsewhere.headers.get("location")).toBe("/auth/error?error=expired");
    refused(await b.request("GET", `/auth/sso/callback?error=access_denied&state=${state}`));
  });

  it("fetches the keys again for an unknown key ID (rotation), and refuses a discovery document naming another issuer", async () => {
    const m = await addMember();
    const rotated = await generateKeyPair("RS256");
    idp.published = [...idp.published, { ...(await exportJWK(rotated.publicKey)), kid: "k2", alg: "RS256", use: "sig" }];
    const before = idp.jwksFetches;
    idp.tamper = { key: rotated.privateKey, kid: "k2" };
    const { cb } = await sso({ sub: `r-${Date.now()}`, email: m.email, email_verified: true });
    expect(cb.headers.get("location")).toBe("/after");
    expect(idp.jwksFetches).toBe(before + 1);

    resetOidcCache();
    idp.tamper = { issuerInDoc: "https://evil.example" };
    const r = await new Browser().request("POST", "/auth/sso", { body: {} });
    expect(r.status).toBe(502);
    expect(r.json.code).toBe("provider_unavailable");
    idp.tamper = {};
    resetOidcCache();
  });
});

describe("single sign-on, per workspace", () => {
  const setSso = (body: Record<string, unknown>, key = ws.keys.admin) => call("PATCH", "/v1/workspace/sign-in", { key, body });

  it("an owner can turn SSO off or narrow its domains for the workspace, and both are checked on every sign-in, subject matches too", async () => {
    const m = await addMember();
    const sub = `ws-${Date.now()}`;
    expect((await sso({ sub, email: m.email, email_verified: true })).cb.headers.get("location")).toBe("/after"); // on by default, now linked
    const adm = await memberWithKey(ws, "admin", ["admin", "ops:write", "ops:read", "restricted:read"]);
    expect((await setSso({ sso: false }, adm.key)).status).toBe(403);
    try {
      expect((await setSso({ sso: false })).json.data).toMatchObject({ sso: false });
      refused((await sso({ sub, email: m.email, email_verified: true })).cb);
      expect((await setSso({ sso: true, sso_allowed_domains: ["Only.Example"] })).json.data).toMatchObject({ sso: true, sso_allowed_domains: ["only.example"] });
      refused((await sso({ sub, email: m.email, email_verified: true })).cb);
      expect((await setSso({ sso_allowed_domains: ["not a domain"] })).status).toBe(422);
      expect((await setSso({ sso_allowed_domains: ["example.com"] })).status).toBe(200);
      expect((await sso({ sub, email: m.email, email_verified: true })).cb.headers.get("location")).toBe("/after");
      // A subject match is checked against the provider's current email, so a server-wide domain list applies to it too.
      process.env.OIDC_ALLOWED_DOMAINS = "only.example";
      resetConfig();
      try {
        refused((await sso({ sub, email: m.email, email_verified: true })).cb);
      } finally {
        delete process.env.OIDC_ALLOWED_DOMAINS;
        resetConfig();
      }
      const log = await call("GET", "/v1/audit-log?action=workspace.sign_in_changed", { key: ws.keys.admin });
      expect(log.json.data[0].details).toEqual({ sso_allowed_domains: ["example.com"] });
    } finally {
      await setSso({ sso: true, sso_allowed_domains: [] });
    }
  });

  it("a member unlinks themselves after a recent sign-in; an admin unlinks a member within the usual rules; both are audited", async () => {
    const m = await addMember();
    const sub = `unlink-${Date.now()}`;
    const { b } = await sso({ sub, email: m.email, email_verified: true });
    const linked = async () => (await call("GET", "/v1/members", { key: ws.keys.admin })).json.data.users.find((u: { id: string }) => u.id === m.id).sign_in.sso_linked;
    expect(await linked()).toBe(true);
    const sid = decodeId((await b.request("GET", "/v1/auth/session")).json.session.id)!.uuid;
    await withTenant(ws.tenantId, (tx) => tx`UPDATE sessions SET signed_in_at = now() - interval '1 hour' WHERE id = ${sid}`);
    expect((await b.request("DELETE", "/v1/auth/sso")).json.code).toBe("recent_sign_in_required");
    expect((await call("DELETE", "/v1/auth/sso", { key: ws.keys.admin })).status).toBe(403);
    const { b: fresh } = await sso({ sub, email: m.email, email_verified: true });
    await fresh.request("GET", "/v1/auth/session"); // for its CSRF token
    expect((await fresh.request("DELETE", "/v1/auth/sso")).json.data).toEqual({ sso_linked: false, unlinked: true });
    expect(await linked()).toBe(false);
    // Unlinked, the old subject no longer reaches this member when the provider reports another email for it.
    const other = await addMember();
    const moved = await sso({ sub, email: other.email, email_verified: true });
    expect((await moved.b.request("GET", "/v1/auth/session")).json.member.id).toBe(other.id);

    // An admin unlinks a member (with a key); not an owner, unless they are one.
    const adm = await memberWithKey(ws, "admin", ["admin", "ops:write", "ops:read", "restricted:read"]);
    expect((await call("DELETE", `/v1/members/${other.id}/sso`, { key: adm.key })).json.data).toEqual({ sso_linked: false, unlinked: true });
    expect((await call("DELETE", `/v1/members/${ws.ownerId}/sso`, { key: adm.key })).status).toBe(403);
    expect((await call("DELETE", `/v1/members/${ws.ownerId}/sso`, { key: ws.keys.admin })).json.data).toEqual({ sso_linked: false, unlinked: false });
    const log = await call("GET", "/v1/audit-log?action=auth.sso_unlinked", { key: ws.keys.admin });
    expect(log.json.data.map((e: { record_id: string }) => e.record_id)).toEqual([decodeId(other.id)!.uuid, decodeId(m.id)!.uuid]);
    expect(log.json.data[0].details).toEqual({ issuer: idp.issuer });
  });

  it("lets the sign-in form reach an authorization endpoint on another origin than the issuer", async () => {
    const port = new URL(idp.issuer).port;
    idp.authEndpoint = `http://localhost:${port}/oauth2/authorize`;
    resetOidcCache();
    try {
      const page = await new Browser().request("GET", "/auth/sign-in");
      expect(page.headers.get("content-security-policy")).toContain(`form-action 'self' ${idp.issuer} http://localhost:${port};`);
      const m = await addMember();
      const { cb } = await sso({ sub: `cog-${Date.now()}`, email: m.email, email_verified: true });
      expect(cb.headers.get("location")).toBe("/after");
    } finally {
      idp.authEndpoint = "";
      resetOidcCache();
    }
  });
});
