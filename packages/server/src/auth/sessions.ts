import { config } from "../config.js";
import { audit } from "../core/audit.js";
import { ALL_SCOPES, OWNER_ROLE, can, type Ctx, type SignInMethod } from "../core/context.js";
import { keyOwner, memberAccess, type Principal } from "../core/keys.js";
import { db, type Tx } from "../db/pool.js";
import { tenantIds } from "../core/auditchain.js";
import { safeEqual } from "../lib/crypto.js";
import { ApiError, forbidden, notFound } from "../lib/errors.js";
import { decodeId, encodeId, uuidv7 } from "../lib/ids.js";
import { csrfToken, isToken, newToken, tokenHash } from "./tokens.js";

/**
 * Browser sessions (ADR 0009). A session is a row in Postgres found by the SHA-256 of the 256-bit
 * token in its HttpOnly cookie. It acts as its member with their full role: permissions, object and
 * field rules are read on every request, exactly as for a key, so a role change or disabling takes
 * effect on the next request. Idle and absolute timeouts are enforced here, server-side.
 */

export interface ClientMeta { requestId: string; userAgent?: string | null; address?: string | null }

/** How recent a sign-in must be for a sensitive change (a password without the current one, an API key, unlinking SSO; a future consent step). */
export const RECENT_SIGN_IN_SECONDS = 600;

const lifetimes = () => ({ idleMs: config().SESSION_IDLE_TIMEOUT_MINUTES * 60_000, absoluteMs: config().SESSION_ABSOLUTE_TIMEOUT_HOURS * 3_600_000 });

export const sessionPublicId = (id: string) => encodeId("ses", id);

/** A context for auth events written before (or without) a request context: the member as actor, on the web surface. */
export function webCtx(tenantId: string, userId: string | null, role: string, meta: ClientMeta, session?: Ctx["session"]): Ctx {
  return { tenantId, actor: userId ? { type: "user", id: userId, role } : { type: "system", id: null, role: OWNER_ROLE }, keyId: null,
    permissions: new Set(), scopes: new Set(), surface: "web", requestId: meta.requestId, ...(session ? { session } : {}) };
}

/**
 * Starts a session for a member who has just proved who they are, in their workspace's transaction.
 * Always a new ID and token: nothing from before sign-in is reused. Returns the token once.
 */
export async function createSession(tx: Tx, m: { tenantId: string; userId: string; role: string }, method: SignInMethod, meta: ClientMeta) {
  const { idleMs, absoluteMs } = lifetimes();
  const id = uuidv7();
  const token = newToken();
  const now = Date.now();
  const expiresAt = new Date(now + absoluteMs);
  const idleExpiresAt = new Date(Math.min(now + idleMs, now + absoluteMs));
  const [row] = await tx<{ signed_in_at: Date }[]>`
    INSERT INTO sessions (tenant_id, id, user_id, token_hash, method, idle_expires_at, expires_at, user_agent, client_address)
    VALUES (${m.tenantId}, ${id}, ${m.userId}, ${tokenHash(token)}, ${method}, ${idleExpiresAt}, ${expiresAt},
            ${meta.userAgent?.slice(0, 256) ?? null}, ${meta.address?.slice(0, 64) ?? null})
    RETURNING signed_in_at`;
  // Any successful sign-in clears the password lockout: the person has shown they control the account.
  await tx`INSERT INTO member_credentials (tenant_id, user_id, last_sign_in_at) VALUES (${m.tenantId}, ${m.userId}, now())
           ON CONFLICT (tenant_id, user_id) DO UPDATE SET last_sign_in_at = now(), password_failures = 0, password_locked_until = NULL`;
  const session = { id, signedInAt: row!.signed_in_at, method };
  await audit(tx, webCtx(m.tenantId, m.userId, m.role, meta, session), { action: "auth.signed_in", objectType: "user", recordId: m.userId, details: { method } });
  return { id, token, expiresAt, idleExpiresAt, csrfToken: csrfToken(id) };
}

/**
 * The member a session cookie acts as, or null for anything invalid, expired, revoked or belonging
 * to a disabled member (without saying which). The next task's consent page should call this (or read
 * `ctx.session` on a /v1 route) and `requireRecentSignIn` for a step-up.
 */
export async function resolveSession(token: string): Promise<Principal | null> {
  if (!isToken(token)) return null;
  const hash = tokenHash(token);
  return db().begin(async (tx) => {
    await tx`SELECT set_config('app.session_lookup', ${hash.toString("hex")}, true)`;
    const [s] = await tx<{ tenant_id: string; id: string; user_id: string; token_hash: Buffer; method: SignInMethod; signed_in_at: Date;
      last_seen_at: Date; idle_expires_at: Date; expires_at: Date; revoked_at: Date | null }[]>`
      SELECT tenant_id, id, user_id, token_hash, method, signed_in_at, last_seen_at, idle_expires_at, expires_at, revoked_at
      FROM sessions WHERE token_hash = ${hash}`;
    const now = Date.now();
    if (!s || !safeEqual(s.token_hash, hash) || s.revoked_at || s.expires_at.getTime() <= now || s.idle_expires_at.getTime() <= now) return null;
    await tx`SELECT set_config('app.session_lookup', '', true), set_config('app.tenant_id', ${s.tenant_id}, true)`;
    const owner = await keyOwner(tx, "user", s.user_id);
    if (!owner || owner.disabled_at || owner.archived_at) return null;
    // At most once a minute, so a busy browser doesn't write on every request.
    if (now - s.last_seen_at.getTime() >= 60_000) {
      await tx`UPDATE sessions SET last_seen_at = now(), idle_expires_at = least(now() + make_interval(secs => ${lifetimes().idleMs / 1000}), expires_at)
               WHERE id = ${s.id}`;
    }
    return {
      tenantId: s.tenant_id, keyId: null, session: { id: s.id, signedInAt: s.signed_in_at, method: s.method },
      actor: { type: "user", id: s.user_id, role: owner.role },
      // A session is the member acting with their whole role: every scope the role can use, so nothing is narrowed.
      ...(await memberAccess(tx, s.tenant_id, owner, ALL_SCOPES)),
    } satisfies Principal;
  }) as Promise<Principal | null>;
}

/** Refuses unless a person signed in (not a key) within `maxAgeSeconds`. For changes that should need a fresh proof of identity. */
export function requireRecentSignIn(ctx: Ctx, maxAgeSeconds = RECENT_SIGN_IN_SECONDS): void {
  if (!ctx.session) throw forbidden("This needs a signed-in person, not an API key");
  if (Date.now() - ctx.session.signedInAt.getTime() > maxAgeSeconds * 1000) {
    throw new ApiError(403, "recent_sign_in_required", `Sign in again to do this (your last sign-in was more than ${Math.round(maxAgeSeconds / 60)} minutes ago)`);
  }
}

export const requireSession = (ctx: Ctx): NonNullable<Ctx["session"]> => {
  if (!ctx.session || ctx.actor.type !== "user" || !ctx.actor.id) throw forbidden("This is for a signed-in person, not an API key");
  return ctx.session;
};

interface SessionRow { id: string; method: string; signed_in_at: Date; last_seen_at: Date; idle_expires_at: Date; expires_at: Date;
  user_agent: string | null; client_address: string | null; revoked_at: Date | null; revoked_reason: string | null }

const view = (r: SessionRow, currentId?: string) => ({
  id: sessionPublicId(r.id), method: r.method, signed_in_at: r.signed_in_at.toISOString(), last_seen_at: r.last_seen_at.toISOString(),
  idle_expires_at: r.idle_expires_at.toISOString(), expires_at: r.expires_at.toISOString(), user_agent: r.user_agent, client_address: r.client_address,
  ...(currentId !== undefined ? { current: r.id === currentId } : {}),
});

/** A member's sessions that still work, newest first. */
export async function listSessions(tx: Tx, userId: string, currentId?: string) {
  const rows = await tx<SessionRow[]>`
    SELECT id, method, signed_in_at, last_seen_at, idle_expires_at, expires_at, user_agent, client_address, revoked_at, revoked_reason
    FROM sessions WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > now() AND idle_expires_at > now()
    ORDER BY signed_in_at DESC LIMIT 200`;
  return rows.map((r) => view(r, currentId));
}

export type RevokeReason = "signed_out" | "revoked" | "revoked_by_admin" | "other_sessions_revoked" | "member_disabled" | "password_changed";

/** Revokes a member's sessions (all, or all but `exceptId`). Returns how many were still live. */
export async function revokeUserSessions(tx: Tx, userId: string, reason: RevokeReason, exceptId?: string): Promise<number> {
  const rows = await tx`UPDATE sessions SET revoked_at = now(), revoked_reason = ${reason}
                        WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > now() ${exceptId ? tx`AND id <> ${exceptId}` : tx``} RETURNING id`;
  return rows.length;
}

/** Revokes one of `userId`'s sessions by public ID. Not found for anyone else's (or an unknown) session. */
export async function revokeOne(tx: Tx, ctx: Ctx, userId: string, publicId: string, reason: RevokeReason) {
  const d = decodeId(publicId);
  if (!d || d.prefix !== "ses") throw notFound("Session");
  const [row] = await tx<{ id: string }[]>`UPDATE sessions SET revoked_at = coalesce(revoked_at, now()), revoked_reason = coalesce(revoked_reason, ${reason})
                                           WHERE id = ${d.uuid} AND user_id = ${userId} RETURNING id`;
  if (!row) throw notFound("Session");
  await audit(tx, ctx, { action: reason === "signed_out" ? "auth.signed_out" : "auth.session_revoked", objectType: "user", recordId: userId,
    details: { revoked_session: publicId, reason } });
  return { id: publicId, revoked: true };
}

/**
 * The rules for seeing or acting on another member's sign-in (their sessions, with addresses and
 * browsers, and their SSO link), as for changing the member: members:manage, an owner's only by an
 * owner, and never someone whose role holds permissions the caller doesn't. Listing is held to the
 * same rules as revoking.
 */
export async function assertMayManageSignInOf(tx: Tx, ctx: Ctx, userId: string) {
  if (!can(ctx, "members:manage")) throw forbidden("Managing other members' sign-in needs the members:manage permission");
  const [m] = await tx<{ role: string; permissions: string[] }[]>`
    SELECT r.key AS role, r.permissions FROM users u JOIN roles r ON r.tenant_id = u.tenant_id AND r.id = u.role_id WHERE u.id = ${userId}`;
  if (!m) throw notFound("Member");
  if (ctx.actor.type === "user" && ctx.actor.id === userId) return;
  if (m.role === OWNER_ROLE && ctx.actor.role !== OWNER_ROLE) throw forbidden("Only an owner can see or change an owner's sign-in");
  const over = m.permissions.filter((p) => !ctx.permissions.has(p as never));
  if (over.length) throw forbidden(`This member has permissions you don't hold: ${over.join(", ")}`);
}

/** Deletes sessions that ended more than a day ago, in every workspace. The worker runs this hourly. */
export async function pruneSessions(): Promise<number> {
  let n = 0;
  for (const t of await tenantIds(db())) {
    n += await db().begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${t}, true)`;
      const rows = await tx`DELETE FROM sessions WHERE least(expires_at, idle_expires_at, coalesce(revoked_at, 'infinity')) < now() - interval '1 day' RETURNING 1`;
      return rows.length;
    }) as number;
  }
  return n;
}
