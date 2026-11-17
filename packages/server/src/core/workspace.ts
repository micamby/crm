import type { Tx } from "../db/pool.js";
import { db } from "../db/pool.js";
import { conflict, forbidden, notFound, unprocessable } from "../lib/errors.js";
import { decodeId, encodeId, uuidv7 } from "../lib/ids.js";
import { audit } from "./audit.js";
import { ACTIVITY_TYPES, DEFAULT_PIPELINE } from "./catalog.js";
import { OWNER_ROLE, can, systemCtx, type Ctx, type Permission } from "./context.js";
import { createTenantKey } from "./encryption.js";
import { createApiKey } from "./keys.js";
import { loadRoleRules } from "./access.js";
import { assertCoversRole, publicRules, resolveRole, seedSystemRoles, type RoleRow } from "./roles.js";
import { loadSchema, seedStandardObjects } from "./schema.js";
import { canonicalEmail, memberEmailProblem } from "../auth/identity.js";
import { revokeUserSessions } from "../auth/sessions.js";
import { listGrants, revokeUserGrants } from "../oauth/grants.js";

export interface CreateWorkspaceInput { name: string; ownerEmail: string; ownerName: string; currency?: string }

/**
 * Creates a workspace: tenant, system roles, owner, standard objects, default pipeline, data key,
 * and two keys for the owner (admin and ops). The key secrets are returned once and never stored.
 */
export async function createWorkspace(input: CreateWorkspaceInput) {
  if (!input.name?.trim()) throw unprocessable("Workspace name is required");
  const emailProblem = memberEmailProblem(input.ownerEmail);
  if (emailProblem) throw unprocessable(`Owner email: ${emailProblem}`);
  const currency = (input.currency ?? "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw unprocessable("currency must be an ISO 4217 code");
  const tenantId = uuidv7();
  const ownerId = uuidv7();
  return db().begin(async (tx) => {
    await tx`INSERT INTO tenant_directory (tenant_id) VALUES (${tenantId})`;
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    await tx`INSERT INTO tenants (tenant_id, name, currency) VALUES (${tenantId}, ${input.name}, ${currency})`;
    await seedSystemRoles(tx);
    const owner = await resolveRole(tx, OWNER_ROLE);
    await tx`INSERT INTO users (tenant_id, id, email, name, role_id) VALUES (${tenantId}, ${ownerId}, ${input.ownerEmail}, ${input.ownerName}, ${owner.id})`;
    const ctx: Ctx = { ...systemCtx(tenantId, "bootstrap") };
    await seedStandardObjects(tx, tenantId);
    for (const t of ACTIVITY_TYPES) {
      await tx`INSERT INTO activity_types (tenant_id, key, label, is_system, editable)
               VALUES (${tenantId}, ${t.key}, ${t.label}, true, ${"editable" in t ? Boolean(t.editable) : false})`;
    }
    const pipelineId = uuidv7();
    await tx`INSERT INTO pipelines (tenant_id, id, name, is_default) VALUES (${tenantId}, ${pipelineId}, ${DEFAULT_PIPELINE.name}, true)`;
    let position = 0;
    for (const s of DEFAULT_PIPELINE.stages) {
      await tx`INSERT INTO stages (tenant_id, id, pipeline_id, name, position, category, default_probability)
               VALUES (${tenantId}, ${uuidv7()}, ${pipelineId}, ${s.name}, ${position++}, ${s.category}, ${s.probability})`;
    }
    await createTenantKey(tx, tenantId);
    await audit(tx, ctx, { action: "workspace.created", details: { name: input.name } });
    const ownerCtx: Ctx = { ...ctx, actor: { type: "user", id: ownerId, role: OWNER_ROLE } };
    const adminKey = await createApiKey(tx, ownerCtx, { name: "Owner admin key", scopes: ["admin", "ops:write", "ops:read", "restricted:read"] }, { bootstrap: true });
    const opsKey = await createApiKey(tx, ownerCtx, { name: "Owner ops key", scopes: ["ops:write", "ops:read"] }, { bootstrap: true });
    return {
      workspace: { id: encodeId("ws", tenantId), name: input.name, currency },
      owner: { id: encodeId("usr", ownerId), email: input.ownerEmail },
      keys: { admin: adminKey.secret, ops: opsKey.secret },
    };
  });
}

export async function getWorkspace(tx: Tx) {
  const [t] = await tx<{ tenant_id: string; name: string; kind: string; currency: string; modules: string[]; schema_version: string; created_at: Date;
    password_sign_in: boolean; sso_sign_in: boolean; sso_allowed_domains: string[]; oauth_apps: boolean; oauth_scopes: string[] }[]>`
    SELECT tenant_id, name, kind, currency, modules, schema_version::text, created_at, password_sign_in, sso_sign_in, sso_allowed_domains,
           oauth_apps, oauth_scopes FROM tenants`;
  if (!t) throw new Error("workspace missing");
  return { id: encodeId("ws", t.tenant_id), name: t.name, kind: t.kind, currency: t.currency, modules: t.modules,
    schema_version: Number(t.schema_version), created_at: t.created_at.toISOString(),
    sign_in: { password: t.password_sign_in, sso: t.sso_sign_in, sso_allowed_domains: t.sso_allowed_domains, oauth_apps: t.oauth_apps, oauth_scopes: t.oauth_scopes } };
}

const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * How members of this workspace may sign in: password on or off, single sign-on on or off, and the
 * email domains SSO accepts here (empty: any the server accepts; it can only narrow the server's
 * OIDC_ALLOWED_DOMAINS). The server settings must allow a method too. Owners only: it decides how
 * every member, owners included, may prove who they are.
 */
export async function setSignInSettings(tx: Tx, ctx: Ctx, input: { password?: boolean; sso?: boolean; sso_allowed_domains?: string[];
  oauth_apps?: boolean; oauth_scopes?: string[] }) {
  if (ctx.actor.role !== OWNER_ROLE) throw forbidden("Only an owner can change how members sign in");
  if (input.password === undefined && input.sso === undefined && input.sso_allowed_domains === undefined && input.oauth_apps === undefined && input.oauth_scopes === undefined) {
    throw unprocessable("Send password, sso, sso_allowed_domains, oauth_apps and/or oauth_scopes");
  }
  // OAuth apps act through the MCP servers; an app can never change how members sign in or who may connect apps.
  if (ctx.oauth) throw forbidden("Connected apps can't change the workspace's sign-in or OAuth settings");
  const domains = input.sso_allowed_domains === undefined ? undefined : [...new Set(input.sso_allowed_domains.map((d) => canonicalEmail(d)))];
  const bad = domains?.filter((d) => !DOMAIN.test(d)) ?? [];
  if (bad.length) throw unprocessable(`Not an email domain (ASCII, e.g. example.com): ${bad.slice(0, 5).join(", ")}`);
  await tx`UPDATE tenants SET password_sign_in = coalesce(${input.password ?? null}::boolean, password_sign_in),
                              sso_sign_in = coalesce(${input.sso ?? null}::boolean, sso_sign_in),
                              sso_allowed_domains = coalesce(${domains ?? null}::text[], sso_allowed_domains),
                              oauth_apps = coalesce(${input.oauth_apps ?? null}::boolean, oauth_apps),
                              oauth_scopes = coalesce(${input.oauth_scopes ? [...new Set(input.oauth_scopes)] : null}::text[], oauth_scopes)`;
  // Turning apps off ends every connection now; narrowing scopes applies to existing tokens on their next request.
  const appsRevoked = input.oauth_apps === false ? await revokeUserGrants(tx, null, "workspace_disabled") : 0;
  await audit(tx, ctx, { action: "workspace.sign_in_changed", details: { ...(input.password !== undefined ? { password: input.password } : {}),
    ...(input.sso !== undefined ? { sso: input.sso } : {}), ...(domains ? { sso_allowed_domains: domains } : {}),
    ...(input.oauth_apps !== undefined ? { oauth_apps: input.oauth_apps, apps_revoked: appsRevoked } : {}),
    ...(input.oauth_scopes ? { oauth_scopes: [...new Set(input.oauth_scopes)] } : {}) } });
  return (await getWorkspace(tx)).sign_in;
}

// --- Members ------------------------------------------------------------------------------------

type MemberType = "user" | "service_account";
interface MemberRow { id: string; email: string | null; name: string; disabled_at: Date | null; created_at: Date;
  role_id: string; role_key: string; role_name: string; permissions: Permission[]; access_version: string }

const memberId = (type: MemberType, id: string) => encodeId(type === "user" ? "usr" : "svc", id);

async function memberRows(tx: Tx, type: MemberType): Promise<MemberRow[]> {
  return type === "user"
    ? tx<MemberRow[]>`SELECT m.id, m.email::text AS email, m.name, m.disabled_at, m.created_at, r.id AS role_id, r.key AS role_key,
                        r.name AS role_name, r.permissions, r.access_version::text
                      FROM users m JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id ORDER BY m.created_at`
    : tx<MemberRow[]>`SELECT m.id, NULL AS email, m.name, m.disabled_at, m.created_at, r.id AS role_id, r.key AS role_key,
                        r.name AS role_name, r.permissions, r.access_version::text
                      FROM service_accounts m JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id ORDER BY m.created_at`;
}

const roleRef = (m: MemberRow) => ({ key: m.role_key, name: m.role_name });

/**
 * Sign-in facts per member, for a periodic access review (no secrets): whether a password is set,
 * whether single sign-on is linked, the last sign-in and how many browser sessions are live.
 */
async function signInFacts(tx: Tx): Promise<Map<string, { has_password: boolean; sso_linked: boolean; last_sign_in_at: string | null; active_sessions: number }>> {
  const rows = await tx<{ id: string; has_password: boolean; sso_linked: boolean; last_sign_in_at: Date | null; active_sessions: number }[]>`
    SELECT u.id, c.password_hash IS NOT NULL AS has_password, c.oidc_subject IS NOT NULL AS sso_linked, c.last_sign_in_at,
           (SELECT count(*)::int FROM sessions s WHERE s.tenant_id = u.tenant_id AND s.user_id = u.id AND s.revoked_at IS NULL
              AND s.expires_at > now() AND s.idle_expires_at > now()) AS active_sessions
    FROM users u LEFT JOIN member_credentials c ON c.tenant_id = u.tenant_id AND c.user_id = u.id`;
  return new Map(rows.map((r) => [r.id, { has_password: Boolean(r.has_password), sso_linked: Boolean(r.sso_linked),
    last_sign_in_at: r.last_sign_in_at?.toISOString() ?? null, active_sessions: r.active_sessions }]));
}

export async function listMembers(tx: Tx) {
  const [users, services, facts] = [await memberRows(tx, "user"), await memberRows(tx, "service_account"), await signInFacts(tx)];
  return {
    users: users.map((u) => ({ id: memberId("user", u.id), email: u.email, name: u.name, role: u.role_key, role_name: u.role_name, active: !u.disabled_at,
      sign_in: facts.get(u.id) })),
    service_accounts: services.map((s) => ({ id: memberId("service_account", s.id), name: s.name, role: s.role_key, role_name: s.role_name, active: !s.disabled_at })),
  };
}

/** Everything granted to a role is checked against the caller here: nobody hands out a permission, or record access, they don't hold. */
async function assertCanAssign(tx: Tx, ctx: Ctx, role: RoleRow, type: MemberType) {
  if (role.key === OWNER_ROLE) {
    if (type === "service_account") throw unprocessable("Service accounts can't hold the owner role");
    if (ctx.actor.role !== OWNER_ROLE) throw forbidden("Only an owner can grant the owner role");
  }
  const missing = role.permissions.filter((p) => !ctx.permissions.has(p));
  if (missing.length) throw forbidden(`The ${role.key} role has permissions you don't hold: ${missing.join(", ")}`);
  await assertCoversRole(tx, ctx, await loadSchema(tx), role, `The ${role.key} role`);
}

export async function addMember(tx: Tx, ctx: Ctx, input: { email: string; name: string; role: string; send_invite?: boolean }) {
  if (!can(ctx, "members:manage")) throw forbidden("Adding members needs the members:manage permission");
  const emailProblem = memberEmailProblem(input.email);
  if (emailProblem) throw unprocessable(emailProblem);
  const role = await resolveRole(tx, input.role, "share");
  await assertCanAssign(tx, ctx, role, "user");
  const id = uuidv7();
  try {
    await tx`INSERT INTO users (tenant_id, id, email, name, role_id) VALUES (${ctx.tenantId}, ${id}, ${input.email}, ${input.name ?? input.email}, ${role.id})`;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw conflict("A member with this email already exists");
    throw e;
  }
  await audit(tx, ctx, { action: "member.added", objectType: "user", recordId: id,
    details: { role: role.key, permissions: role.permissions, ...(input.send_invite ? { invitation: "queued" } : {}) } });
  return { id: memberId("user", id), email: input.email, name: input.name, role: role.key, role_name: role.name, active: true,
    ...(input.send_invite ? { invitation: "queued" } : {}) };
}

export async function addServiceAccount(tx: Tx, ctx: Ctx, input: { name: string; role: string }) {
  if (!can(ctx, "members:manage")) throw forbidden("Adding service accounts needs the members:manage permission");
  if (!input.name?.trim()) throw unprocessable("name is required");
  const role = await resolveRole(tx, input.role, "share");
  await assertCanAssign(tx, ctx, role, "service_account");
  const id = uuidv7();
  try {
    await tx`INSERT INTO service_accounts (tenant_id, id, name, role_id, created_by) VALUES (${ctx.tenantId}, ${id}, ${input.name}, ${role.id}, ${ctx.actor.id})`;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw conflict("A service account with this name already exists");
    throw e;
  }
  await audit(tx, ctx, { action: "service_account.created", objectType: "service_account", recordId: id, details: { role: role.key, permissions: role.permissions } });
  return { id: memberId("service_account", id), name: input.name, role: role.key, role_name: role.name, active: true };
}

/** A member's identity and role, locked for the rest of the transaction. */
export async function loadMember(tx: Tx, type: MemberType, id: string, lock = false) {
  const table = type === "user" ? tx`users` : tx`service_accounts`;
  const [m] = await tx<{ id: string; disabled_at: Date | null; role_id: string; role_key: string; permissions: Permission[]; access_version: string }[]>`
    SELECT m.id, m.disabled_at, r.id AS role_id, r.key AS role_key, r.permissions, r.access_version::text
    FROM ${table} m JOIN roles r ON r.tenant_id = m.tenant_id AND r.id = m.role_id
    WHERE m.id = ${id} ${lock ? tx`FOR UPDATE OF m` : tx``}`;
  return m ?? null;
}

/** Parses a member ID: `usr_…` or `svc_…`, optionally restricted to one kind. */
export function parseMemberId(publicId: string, only?: MemberType): { type: MemberType; id: string } | null {
  const d = decodeId(publicId);
  if (!d || (d.prefix !== "usr" && d.prefix !== "svc")) return null;
  const type: MemberType = d.prefix === "usr" ? "user" : "service_account";
  return only && only !== type ? null : { type, id: d.uuid };
}

export interface UpdateMemberInput { role?: string; active?: boolean }

/**
 * Changes a member's role and/or turns them off or on. Disabling revokes every key the member
 * holds in the same transaction, so deprovisioning can't leave a working credential behind.
 */
export async function updateMember(tx: Tx, ctx: Ctx, publicId: string, patch: UpdateMemberInput, only?: MemberType) {
  if (!can(ctx, "members:manage")) throw forbidden("Changing members needs the members:manage permission");
  const ref = parseMemberId(publicId, only);
  if (!ref) throw notFound("Member");
  const current = await loadMember(tx, ref.type, ref.id, true);
  if (!current) throw notFound("Member");
  if (patch.role === undefined && patch.active === undefined) throw unprocessable("Send role and/or active");
  if (ctx.actor.type === ref.type && ctx.actor.id === ref.id) throw forbidden("You can't change your own role or disable yourself");
  // Acting on someone with more access than you is a way around the grant rules (and lets you lock out admins).
  const over = current.permissions.filter((p) => !ctx.permissions.has(p));
  if (over.length) throw forbidden(`This member has permissions you don't hold: ${over.join(", ")}`);
  await assertCoversRole(tx, ctx, await loadSchema(tx),
    { id: current.role_id, key: current.role_key, permissions: current.permissions, access_version: current.access_version }, "This member's role");
  if (current.role_key === OWNER_ROLE && ctx.actor.role !== OWNER_ROLE) throw forbidden("Only an owner can change or disable an owner");

  const role = patch.role !== undefined ? await resolveRole(tx, patch.role, "share") : null;
  const roleChanges = role !== null && role.id !== current.role_id;
  const wasActive = !current.disabled_at;
  const active = patch.active ?? wasActive;
  if (roleChanges) await assertCanAssign(tx, ctx, role, ref.type);
  if (active && !wasActive && !roleChanges) {
    // Re-enabling grants the member's role again; it must still exist and be grantable by the caller.
    const held = await tx<RoleRow[]>`SELECT id, key, name, description, permissions, is_system, created_at, updated_at, archived_at, access_version::text
                                     FROM roles WHERE id = ${current.role_id} FOR SHARE`;
    if (!held[0] || held[0].archived_at) throw unprocessable("This member's role was archived; re-enable them with a new role");
    await assertCanAssign(tx, ctx, held[0], ref.type);
  }
  const losesOwner = current.role_key === OWNER_ROLE && wasActive && (!active || roleChanges);
  if (losesOwner) {
    const others = await tx<{ id: string }[]>`
      SELECT u.id FROM users u JOIN roles r ON r.tenant_id = u.tenant_id AND r.id = u.role_id
      WHERE r.key = ${OWNER_ROLE} AND r.is_system AND u.disabled_at IS NULL AND u.id <> ${ref.id} FOR UPDATE OF u`;
    if (others.length === 0) throw conflict("This is the last active owner; make someone else an owner first");
  }

  const table = ref.type === "user" ? tx`users` : tx`service_accounts`;
  const objectType = ref.type;
  let keysRevoked = 0;
  let sessionsRevoked = 0;
  let appsRevoked = 0;
  if (roleChanges) {
    await tx`UPDATE ${table} SET role_id = ${role.id} WHERE id = ${ref.id}`;
    await audit(tx, ctx, { action: `${ref.type === "user" ? "member" : "service_account"}.role_changed`, objectType, recordId: ref.id,
      details: { from: current.role_key, to: role.key,
        permissions_added: role.permissions.filter((p) => !current.permissions.includes(p)),
        permissions_removed: current.permissions.filter((p) => !role.permissions.includes(p)) } });
  }
  if (active !== wasActive) {
    await tx`UPDATE ${table} SET disabled_at = ${active ? null : tx`now()`} WHERE id = ${ref.id}`;
    if (!active) {
      const revoked = await tx`UPDATE api_keys SET revoked_at = now()
                               WHERE owner_type = ${ref.type} AND owner_id = ${ref.id} AND revoked_at IS NULL RETURNING id`;
      keysRevoked = revoked.length;
      // Browser sessions end in the same transaction, so a disabled person is signed out everywhere at once.
      if (ref.type === "user") sessionsRevoked = await revokeUserSessions(tx, ref.id, "member_disabled");
      // And every app they connected over OAuth, with its tokens.
      if (ref.type === "user") appsRevoked = await revokeUserGrants(tx, ref.id, "member_disabled");
    }
    await audit(tx, ctx, { action: `${ref.type === "user" ? "member" : "service_account"}.${active ? "enabled" : "disabled"}`, objectType, recordId: ref.id,
      details: active ? { role: (role ?? { key: current.role_key }).key }
        : { role: current.role_key, keys_revoked: keysRevoked, ...(ref.type === "user" ? { sessions_revoked: sessionsRevoked, apps_revoked: appsRevoked } : {}) } });
  }
  const after = (await memberRows(tx, ref.type)).find((m) => m.id === ref.id)!;
  return { id: memberId(ref.type, ref.id), ...(after.email ? { email: after.email } : {}), name: after.name, role: after.role_key,
    role_name: after.role_name, active: !after.disabled_at, ...(keysRevoked ? { keys_revoked: keysRevoked } : {}),
    ...(sessionsRevoked ? { sessions_revoked: sessionsRevoked } : {}), ...(appsRevoked ? { apps_revoked: appsRevoked } : {}) };
}

/**
 * Who can do what: every member and service account with their role, permissions and keys.
 * This is what an operator exports for a periodic access review.
 */
export async function accessReview(tx: Tx, ctx: Ctx) {
  if (!can(ctx, "audit:read")) throw forbidden("The access review needs the audit:read permission");
  const keys = await tx<{ id: string; owner_type: MemberType; owner_id: string; name: string; scopes: string[]; environment: string;
    created_at: Date; last_used_at: Date | null; expires_at: Date | null; revoked_at: Date | null }[]>`
    SELECT id, owner_type, owner_id, name, scopes, environment, created_at, last_used_at, expires_at, revoked_at FROM api_keys ORDER BY created_at`;
  const keysOf = (type: MemberType, id: string) => keys.filter((k) => k.owner_type === type && k.owner_id === id).map((k) => ({
    id: encodeId("key", k.id), name: k.name, scopes: k.scopes, environment: k.environment, created_at: k.created_at.toISOString(),
    last_used_at: k.last_used_at?.toISOString() ?? null, expires_at: k.expires_at?.toISOString() ?? null,
    revoked_at: k.revoked_at?.toISOString() ?? null,
    usable: !k.revoked_at && (!k.expires_at || k.expires_at.getTime() > Date.now()),
  }));
  // Object and field rules are part of what a member can do, so the review shows them with the permissions.
  const schema = await loadSchema(tx);
  const facts = await signInFacts(tx);
  // Apps connected over OAuth act as their member, so they are part of what each member can do.
  const grants = await listGrants(tx, null);
  const members = [...(await memberRows(tx, "user")).map((m) => ({ m, type: "user" as const })),
    // "service_account" is a member type here, not a credential, so the secret scanner's match on the next line is silenced.
    ...(await memberRows(tx, "service_account")).map((m) => ({ m, type: "service_account" as const }))]; // nosemgrep: generic.secrets.security.detected-google-gcm-service-account.detected-google-gcm-service-account
  const out = [];
  for (const { m, type } of members) {
    out.push({
      id: memberId(type, m.id), type, ...(m.email ? { email: m.email } : {}), name: m.name, active: !m.disabled_at,
      role: roleRef(m), permissions: m.permissions, record_rules: publicRules(schema, await loadRoleRules(tx, ctx.tenantId, m.role_id, m.access_version)),
      created_at: m.created_at.toISOString(), keys: keysOf(type, m.id),
      ...(type === "user" ? { sign_in: facts.get(m.id), apps: grants.filter((g) => g.member === memberId("user", m.id)) } : {}),
    });
  }
  return { generated_at: new Date().toISOString(), members: out };
}
