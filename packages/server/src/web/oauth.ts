import type { Context, Hono } from "hono";
import { LIMITS, addressKey, hit } from "../auth/limits.js";
import { csrfToken, csrfTokenMatches, originRefusal } from "../auth/tokens.js";
import { oauthSettings } from "../config.js";
import type { Ctx } from "../core/context.js";
import { withTenant } from "../db/tx.js";
import { ApiError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { AuthorizeError, issueCode, parseAuthorizeRequest, planConsent, recordDenial, redirectWith, type AuthzRequest } from "../oauth/authorize.js";
import { redirectHost } from "../oauth/clients.js";
import { grantOwner, listGrants, revokeGrantAudited } from "../oauth/grants.js";
import { SCOPE_TEXT } from "../oauth/scopes.js";
import { clientAddress, type Env } from "../api/app.js";
import { html, sessionCtx } from "./handlers.js";
import { appsPage, consentPage, oauthErrorPage } from "./pages.js";

/**
 * The authorization endpoint and the connected apps page (ADR 0010). Signing in for consent is the
 * ordinary people sign-in: without a session, /oauth/authorize sends the browser to /auth/sign-in with
 * the request as `return_to`, and the request starts over (and is validated again) when it comes back.
 *
 * The consent decision is a form post with the session's CSRF token and the same Origin and
 * Sec-Fetch-Site checks as every other form; the pages can't be framed and run no script. The
 * page's form-action allows the app's redirect origin too, since browsers apply it to the redirect
 * the form leads to.
 */

type C = Context<Env>;

/** Longest authorization request carried through sign-in as return_to (the sign-in flow stores at most this). */
const MAX_RETURN_TO = 2048;

const formTarget = (uri: string) => {
  try {
    return [new URL(uri).origin];
  } catch {
    return [];
  }
};

/**
 * Answers a refused request with a page. With an unknown client or a redirect URI the client didn't
 * register, nothing points back at the app. Otherwise the page links back to the app's redirect URI
 * with error, state and iss for the person to follow: redirecting at once, before anyone has looked,
 * would let any registered client use this origin as an open redirector.
 */
function refuse(c: C, e: AuthorizeError) {
  logger.info({ requestId: c.get("requestId"), event: "oauth_authorize_refused", error: e.code }, "authorization request refused");
  const back = e.redirect ? { href: redirectWith(e.redirect.uri, { error: e.code, error_description: e.message, state: e.redirect.state }), host: redirectHost(e.redirect.uri) } : null;
  return html(c, oauthErrorPage(e.code, e.message, back), e.code === "temporarily_unavailable" ? 503 : 400);
}

/** Every value of every parameter, so a parameter sent twice can be refused. */
function allValues(raw: Record<string, unknown>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    const list = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string" && !x.includes("\0") && x.length <= 4096);
    if (list.length) out[k] = list;
  }
  return out;
}

async function consent(c: C, ctx: Ctx, req: AuthzRequest, status = 200) {
  const plan = await withTenant(ctx.tenantId, (tx) => planConsent(tx, ctx, req));
  const back = `/oauth/authorize?${new URLSearchParams(req.params).toString()}`;
  return html(c, consentPage({
    clientName: req.client.name, clientId: req.client.clientId, clientKind: req.client.kind, redirectHost: redirectHost(req.redirectUri), loopback: plan.loopback,
    resourceName: req.resource, resourceUrl: req.resourceUrl, scopes: plan.granted.map((s) => ({ scope: s, text: SCOPE_TEXT[s] })), dropped: plan.dropped,
    blocked: plan.blocked, signInAgain: plan.recentSignInNeeded ? `/auth/sign-in?return_to=${encodeURIComponent(back)}` : null,
    member: plan.member, workspace: plan.workspace, csrf: csrfToken(ctx.session!.id), params: req.params,
  }), status, formTarget(req.redirectUri));
}

export function mountOAuthPages(app: Hono<Env>): void {
  const limitedPage = (c: C, seconds: number) => {
    c.header("Retry-After", String(seconds));
    return html(c, oauthErrorPage("rate_limited"), 429);
  };

  app.get("/oauth/authorize", async (c) => {
    if (!oauthSettings()) return html(c, oauthErrorPage("unavailable"), 404);
    // Per address first: the control on floods. A budget shared by everyone using a client is never
    // charged for a request that proves nothing (anyone can name a public client_id): only a signed-in
    // member's request whose redirect URI checked out counts, per client and workspace.
    const caller = addressKey(clientAddress(c));
    const wait = hit(LIMITS.oauthAuthorize, caller);
    if (wait !== null) return limitedPage(c, wait);
    let req: AuthzRequest;
    try {
      req = await parseAuthorizeRequest(allValues(c.req.queries()), caller);
    } catch (e) {
      if (e instanceof AuthorizeError) return refuse(c, e);
      throw e;
    }
    const ctx = await sessionCtx(c);
    const perClient = ctx ? hit(LIMITS.oauthAuthorizeClient, `${req.client.clientId}|${ctx.tenantId}`) : null;
    if (perClient !== null) return limitedPage(c, perClient);
    if (!ctx) {
      const url = new URL(c.req.url);
      const back = `${url.pathname}${url.search}`;
      if (back.length > MAX_RETURN_TO) return html(c, oauthErrorPage("too_long"), 400);
      return c.redirect(`/auth/sign-in?return_to=${encodeURIComponent(back)}`, 303);
    }
    return consent(c, ctx, req);
  });

  app.post("/oauth/authorize", async (c) => {
    if (!oauthSettings()) return html(c, oauthErrorPage("unavailable"), 404);
    // Origin first: a post from another site is answered with a page, never a redirect.
    if (originRefusal({ origin: c.req.header("origin"), fetchSite: c.req.header("sec-fetch-site") }, { formPost: true })) {
      logger.warn({ requestId: c.get("requestId"), event: "csrf_refused", path: "/oauth/authorize" }, "cross-site consent refused");
      return html(c, oauthErrorPage("csrf_failed"), 403);
    }
    const ctx = await sessionCtx(c);
    if (!ctx) return html(c, oauthErrorPage("csrf_failed", "Your session ended. Start again from the app."), 403);
    const form = allValues(await c.req.parseBody({ all: true }));
    if (!csrfTokenMatches(ctx.session!.id, form.csrf_token?.length === 1 ? form.csrf_token[0] : null)) return html(c, oauthErrorPage("csrf_failed"), 403);
    let req: AuthzRequest;
    try {
      req = await parseAuthorizeRequest(form, addressKey(clientAddress(c)));
    } catch (e) {
      if (e instanceof AuthorizeError) return refuse(c, e);
      throw e;
    }
    const decision = form.decision?.[0];
    if (decision !== "approve") {
      await withTenant(ctx.tenantId, (tx) => recordDenial(tx, ctx, req));
      return c.redirect(redirectWith(req.redirectUri, { error: "access_denied", error_description: "The member did not allow access", state: req.state }), 303);
    }
    try {
      const code = await withTenant(ctx.tenantId, async (tx) => {
        const plan = await planConsent(tx, ctx, req);
        if (plan.blocked || plan.recentSignInNeeded) return null;
        return issueCode(tx, ctx, req, plan);
      });
      // Approval was impossible (the page said why and offered only Cancel, or the sign-in got old): show the page again.
      if (!code) return consent(c, ctx, req, 403);
      return c.redirect(redirectWith(req.redirectUri, { code, state: req.state }), 303);
    } catch (e) {
      if (e instanceof AuthorizeError) return html(c, oauthErrorPage("too_many_apps"), 409);
      throw e;
    }
  });

  app.get("/auth/apps", async (c) => {
    const ctx = await sessionCtx(c);
    if (!ctx) return c.redirect("/auth/sign-in?return_to=%2Fauth%2Fapps", 303);
    const grants = await withTenant(ctx.tenantId, (tx) => listGrants(tx, ctx.actor.id));
    return html(c, appsPage(grants.map((g) => ({ id: g.id, name: g.client.name, kind: g.client.kind, redirectHost: g.client.redirect_host, scopes: g.scopes,
      resource: g.resource, createdAt: g.created_at, lastUsedAt: g.last_used_at })), csrfToken(ctx.session!.id), c.req.query("done") === "1"));
  });

  app.post("/auth/apps/revoke", async (c) => {
    if (originRefusal({ origin: c.req.header("origin"), fetchSite: c.req.header("sec-fetch-site") }, { formPost: true })) return html(c, oauthErrorPage("csrf_failed"), 403);
    const ctx = await sessionCtx(c);
    if (!ctx) return c.redirect("/auth/sign-in", 303);
    const form = await c.req.parseBody();
    if (!csrfTokenMatches(ctx.session!.id, typeof form.csrf_token === "string" ? form.csrf_token : null)) return html(c, oauthErrorPage("csrf_failed"), 403);
    try {
      await withTenant(ctx.tenantId, async (tx) => {
        const g = await grantOwner(tx, typeof form.app === "string" ? form.app : "");
        if (g.userId !== ctx.actor.id) throw new ApiError(404, "not_found", "Connected app not found");
        await revokeGrantAudited(tx, ctx, g, false);
      });
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
    }
    return c.redirect("/auth/apps?done=1", 303);
  });
}
