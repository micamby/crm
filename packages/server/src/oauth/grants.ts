import { config, oauthSettings } from "../config.js";
import { audit } from "../core/audit.js";
import { tenantIds } from "../core/auditchain.js";
import type { Ctx, Scope } from "../core/context.js";
import { keyOwner, memberAccess, type Principal } from "../core/keys.js";
import { db, type Tx } from "../db/pool.js";
import { safeEqual } from "../lib/crypto.js";
import { notFound } from "../lib/errors.js";
import { decodeId, encodeId, uuidv7 } from "../lib/ids.js";
import { redirectHost } from "./clients.js";
import { ACCESS_PREFIX, REFRESH_PREFIX, RESOURCES, expandScopes, isAccessToken, newSecret, secretHash, type ResourceName } from "./scopes.js";

/**
 * Grants and their tokens (ADR 0010). A grant is one approved connection: a member, in one workspace,
 * letting one client reach one MCP endpoint (the resource, which is the tokens' audience) with some
 * scopes. Its tokens are opaque random strings stored as SHA-256 hashes, found like API keys and
 * sessions by a narrow lookup policy before the tenant is known. Every use re-reads the member's role,
 * the grant and the workspace's OAuth settings, so revoking, disabling or narrowing applies at once.
 */

export const grantPublicId = (id: string) => encodeId("ogr", id);

export type GrantRevokeReason = "revoked" | "revoked_by_admin" | "member_disabled" | "signed_out_everywhere" | "replaced" | "refresh_reuse"
  | "code_reuse" | "workspace_disabled";

/** A context for OAuth events: the member as actor, on the oauth surface, naming the grant and client. */
export function oauthCtx(tenantId: string, userId: string, role: string, requestId: string, grant: { id: string; clientId: string }): Ctx {
  return { tenantId, actor: { type: "user", id: userId, role }, keyId: null, permissions: new Set(), scopes: new Set(), surface: "oauth", requestId,
    oauth: { grantId: grant.id, clientId: grant.clientId } };
}

const lifetimes = () => {
  const c = config();
  return { accessS: c.OAUTH_ACCESS_TOKEN_MINUTES * 60, refreshS: c.OAUTH_REFRESH_TOKEN_DAYS * 86_400, grantDays: c.OAUTH_GRANT_MAX_DAYS };
};

/** Issues an access token and a rotated refresh token for a grant. Neither outlives the grant. */
export async function issueTokens(tx: Tx, tenantId: string, grant: { id: string; expires_at: Date }, scopes: Scope[] | null) {
  const { accessS, refreshS } = lifetimes();
  const access = newSecret(ACCESS_PREFIX);
  const refresh = newSecret(REFRESH_PREFIX);
  const now = Date.now();
  const accessExp = new Date(Math.min(now + accessS * 1000, grant.expires_at.getTime()));
  const refreshExp = new Date(Math.min(now + refreshS * 1000, grant.expires_at.getTime()));
  await tx`INSERT INTO oauth_tokens (tenant_id, id, grant_id, kind, token_hash, scopes, expires_at)
           VALUES (${tenantId}, ${uuidv7()}, ${grant.id}, 'access', ${secretHash(access)}, ${scopes}, ${accessExp}),
                  (${tenantId}, ${uuidv7()}, ${grant.id}, 'refresh', ${secretHash(refresh)}, NULL, ${refreshExp})`;
  return { access, refresh, expiresIn: Math.max(1, Math.floor((accessExp.getTime() - now) / 1000)) };
}

/** Creates a grant for a redeemed code. Earlier live grants of the same member, client and resource are replaced: one connection per app and server. */
export async function createGrant(tx: Tx, ctx: Ctx, g: { userId: string; sessionId: string; clientId: string; clientName: string; clientKind: string;
  redirectUri: string; scopes: string[]; resource: string }) {
  const replaced = await tx<{ id: string }[]>`
    UPDATE oauth_grants SET revoked_at = now(), revoked_reason = 'replaced'
    WHERE user_id = ${g.userId} AND client_id = ${g.clientId} AND resource = ${g.resource} AND revoked_at IS NULL RETURNING id`;
  if (replaced.length) await tx`UPDATE oauth_tokens SET revoked_at = now() WHERE grant_id IN ${tx(replaced.map((r) => r.id))} AND revoked_at IS NULL`;
  const id = uuidv7();
  const [row] = await tx<{ expires_at: Date }[]>`
    INSERT INTO oauth_grants (tenant_id, id, user_id, session_id, client_id, client_name, client_kind, redirect_uri, scopes, resource, expires_at)
    VALUES (${ctx.tenantId}, ${id}, ${g.userId}, ${g.sessionId}, ${g.clientId}, ${g.clientName}, ${g.clientKind}, ${g.redirectUri}, ${g.scopes}, ${g.resource},
            now() + make_interval(days => ${lifetimes().grantDays}))
    RETURNING expires_at`;
  return { id, expires_at: row!.expires_at, replaced: replaced.map((r) => grantPublicId(r.id)) };
}

/** Revokes a grant and all its tokens. Returns false when it was already revoked. */
export async function revokeGrant(tx: Tx, grantId: string, reason: GrantRevokeReason): Promise<boolean> {
  const rows = await tx`UPDATE oauth_grants SET revoked_at = now(), revoked_reason = ${reason} WHERE id = ${grantId} AND revoked_at IS NULL RETURNING 1`;
  await tx`UPDATE oauth_tokens SET revoked_at = now() WHERE grant_id = ${grantId} AND revoked_at IS NULL`;
  return rows.length > 0;
}

/** Revokes every live grant of a member (or, with no member, of the whole workspace). Returns how many. */
export async function revokeUserGrants(tx: Tx, userId: string | null, reason: GrantRevokeReason): Promise<number> {
  const rows = await tx<{ id: string }[]>`UPDATE oauth_grants SET revoked_at = now(), revoked_reason = ${reason}
    WHERE revoked_at IS NULL ${userId ? tx`AND user_id = ${userId}` : tx``} RETURNING id`;
  if (rows.length) await tx`UPDATE oauth_tokens SET revoked_at = now() WHERE grant_id IN ${tx(rows.map((r) => r.id))} AND revoked_at IS NULL`;
  return rows.length;
}

/** A token's scopes now: its own (or its grant's), within the grant and what the workspace allows, `ops:write` implying `ops:read` throughout. The role narrows them further (memberAccess). */
export function tokenScopes(token: string[] | null, grant: string[], workspace: string[]): Scope[] {
  const granted = new Set(expandScopes(grant));
  const allowed = new Set(expandScopes(workspace));
  return expandScopes(token ?? grant).filter((x) => granted.has(x) && allowed.has(x));
}

export interface OAuthPrincipal extends Principal { oauth: { grantId: string; clientId: string; resource: ResourceName } }

/**
 * The member an access token acts as, or null for anything invalid, expired or revoked, a revoked or
 * expired grant, a disabled member or a workspace that turned OAuth off (without saying which).
 * Scopes are the token's (or grant's), within what the workspace allows now, with `ops:write`
 * implying `ops:read`; then, as for a key, the member's current role decides the permissions.
 */
export async function resolveAccessToken(token: string): Promise<OAuthPrincipal | null> {
  const s = oauthSettings();
  if (!s || !isAccessToken(token)) return null;
  const hash = secretHash(token);
  return db().begin(async (tx) => {
    await tx`SELECT set_config('app.oauth_token_lookup', ${hash.toString("hex")}, true)`;
    const [t] = await tx<{ tenant_id: string; grant_id: string; kind: string; token_hash: Buffer; scopes: string[] | null; expires_at: Date; revoked_at: Date | null }[]>`
      SELECT tenant_id, grant_id, kind, token_hash, scopes, expires_at, revoked_at FROM oauth_tokens WHERE token_hash = ${hash}`;
    if (!t || t.kind !== "access" || !safeEqual(t.token_hash, hash) || t.revoked_at || t.expires_at.getTime() <= Date.now()) return null;
    await tx`SELECT set_config('app.oauth_token_lookup', '', true), set_config('app.tenant_id', ${t.tenant_id}, true)`;
    const [g] = await tx<{ user_id: string; client_id: string; scopes: string[]; resource: string; expires_at: Date; revoked_at: Date | null; last_used_at: Date | null }[]>`
      SELECT user_id, client_id, scopes, resource, expires_at, revoked_at, last_used_at FROM oauth_grants WHERE id = ${t.grant_id}`;
    if (!g || g.revoked_at || g.expires_at.getTime() <= Date.now()) return null;
    const resource = RESOURCES.find((r) => s.resources[r] === g.resource);
    if (!resource) return null;
    const [w] = await tx<{ oauth_apps: boolean; oauth_scopes: string[] }[]>`SELECT oauth_apps, oauth_scopes FROM tenants`;
    if (!w?.oauth_apps) return null;
    const owner = await keyOwner(tx, "user", g.user_id);
    if (!owner || owner.disabled_at || owner.archived_at) return null;
    const scopes = tokenScopes(t.scopes, g.scopes, w.oauth_scopes);
    // At most once a minute, so a busy client doesn't write on every request.
    if (!g.last_used_at || Date.now() - g.last_used_at.getTime() >= 60_000) await tx`UPDATE oauth_grants SET last_used_at = now() WHERE id = ${t.grant_id}`;
    return {
      tenantId: t.tenant_id, keyId: null, actor: { type: "user", id: g.user_id, role: owner.role },
      oauth: { grantId: t.grant_id, clientId: g.client_id, resource },
      ...(await memberAccess(tx, t.tenant_id, owner, scopes)),
    } satisfies OAuthPrincipal;
  }) as Promise<OAuthPrincipal | null>;
}

interface GrantRow { id: string; user_id: string; client_id: string; client_name: string; client_kind: string; redirect_uri: string; scopes: string[];
  resource: string; created_at: Date; last_used_at: Date | null; expires_at: Date }

const grantView = (r: GrantRow) => ({
  id: grantPublicId(r.id), member: encodeId("usr", r.user_id),
  client: { id: r.client_id, name: r.client_name, kind: r.client_kind, verified_by_document: r.client_kind === "metadata_document", redirect_host: redirectHost(r.redirect_uri) },
  scopes: r.scopes, resource: r.resource, created_at: r.created_at.toISOString(), last_used_at: r.last_used_at?.toISOString() ?? null,
  expires_at: r.expires_at.toISOString(),
});

/** Live grants of one member (or every member, for the access review), newest first. */
export async function listGrants(tx: Tx, userId: string | null) {
  const rows = await tx<GrantRow[]>`
    SELECT id, user_id, client_id, client_name, client_kind, redirect_uri, scopes, resource, created_at, last_used_at, expires_at
    FROM oauth_grants WHERE revoked_at IS NULL AND expires_at > now() ${userId ? tx`AND user_id = ${userId}` : tx``}
    ORDER BY created_at DESC LIMIT ${userId ? 500 : 100_000}`;
  return rows.map(grantView);
}

/** A grant's owner by public ID (ogr_…), or not found. */
export async function grantOwner(tx: Tx, publicId: string): Promise<{ id: string; userId: string; clientId: string }> {
  const d = decodeId(publicId);
  if (d?.prefix !== "ogr") throw notFound("Connected app");
  const [g] = await tx<{ user_id: string; client_id: string }[]>`SELECT user_id, client_id FROM oauth_grants WHERE id = ${d.uuid} AND revoked_at IS NULL`;
  if (!g) throw notFound("Connected app");
  return { id: d.uuid, userId: g.user_id, clientId: g.client_id };
}

/** Revokes one grant on a member's or an admin's request, audited. */
export async function revokeGrantAudited(tx: Tx, ctx: Ctx, grant: { id: string; userId: string; clientId: string }, byAdmin: boolean) {
  await revokeGrant(tx, grant.id, byAdmin ? "revoked_by_admin" : "revoked");
  await audit(tx, ctx, { action: "oauth.grant_revoked", objectType: "user", recordId: grant.userId,
    details: { grant: grantPublicId(grant.id), client_id: grant.clientId, by_admin: byAdmin } });
  return { id: grantPublicId(grant.id), revoked: true };
}

/**
 * Deletes what has ended, in every workspace: codes after a day, tokens a day after they expire or are
 * revoked, used refresh tokens a week after use (reuse of an older one is then just invalid, not
 * detected), and revoked or expired grants after 90 days. The worker runs this hourly.
 */
export async function pruneGrants(): Promise<number> {
  let n = 0;
  for (const t of await tenantIds(db())) {
    n += await db().begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${t}, true)`;
      const codes = await tx`DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 day' RETURNING 1`;
      const tokens = await tx`DELETE FROM oauth_tokens WHERE least(expires_at, coalesce(revoked_at, 'infinity')) < now() - interval '1 day'
                                OR (kind = 'refresh' AND used_at < now() - interval '7 days') RETURNING 1`;
      const grants = await tx`DELETE FROM oauth_grants WHERE least(expires_at, coalesce(revoked_at, 'infinity')) < now() - interval '90 days' RETURNING 1`;
      return codes.length + tokens.length + grants.length;
    }) as number;
  }
  return n;
}
