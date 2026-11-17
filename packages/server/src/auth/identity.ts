import { db } from "../db/pool.js";
import { withTenant } from "../db/tx.js";
import { encodeId } from "../lib/ids.js";

/**
 * Finding a person's memberships before any workspace is known (ADR 0009). Members are rows per
 * workspace, so one email can be a member of several. `sign_in_identities` maps an email (or an
 * OIDC issuer and subject) to (workspace, member) pairs, and its `identity_lookup` policy lets a
 * transaction read only the rows of the one identity it names. Everything else about each
 * membership is then read inside that workspace, under the normal isolation policy.
 */

export interface Candidate { t: string; u: string }

/** At most this many memberships are considered per identity, so one sign-in costs a bounded number of transactions. */
export const MAX_CANDIDATES = 20;

export const oidcIdentity = (issuer: string, subject: string) => `${issuer}\n${subject}`;

/**
 * The form an email is matched in: surrounding ASCII whitespace trimmed and only A-Z lowercased.
 * Exactly what `app.canonical_email` computes in SQL (migration 010), never a locale's or Unicode's
 * case rules, which fold some other letters (the Kelvin sign, dotted capital I) into ASCII ones.
 */
export const canonicalEmail = (email: string): string => email.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "").replace(/[A-Z]+/g, (s) => s.toLowerCase());

const MEMBER_EMAIL = /^[\x21-\x3f\x41-\x7e]{1,64}@[\x21-\x3f\x41-\x7e]{1,190}\.[\x21-\x3f\x41-\x7e]{1,63}$/;
/**
 * Why an email can't be given to a member, or null. Printable ASCII only, no spaces or control
 * characters: internationalized addresses aren't supported yet, because sign-in can't tell apart
 * addresses that differ only in how their letters fold. Existing rows that break this still work,
 * matched by their canonical form.
 */
export function memberEmailProblem(email: unknown): string | null {
  if (typeof email !== "string" || email.length > 254 || !MEMBER_EMAIL.test(email)) {
    return "A valid email is required: printable ASCII, no spaces (internationalized addresses aren't supported yet)";
  }
  return null;
}

/**
 * The memberships of an identity (active members only: disabling removes the email identity), at
 * most MAX_CANDIDATES, in a fixed order: for an email, members stored with exactly the typed address
 * first, then by workspace. `more` says there were others, so nothing is dropped silently; naming the
 * workspace (`tenant`) looks in that one only.
 */
export async function lookupIdentity(kind: "email" | "oidc", value: string, tenant?: string | null): Promise<{ candidates: Candidate[]; more: boolean }> {
  const v = kind === "email" ? canonicalEmail(value) : value;
  if (!v || v.length > 800) return { candidates: [], more: false };
  return db().begin(async (tx) => {
    await tx`SELECT set_config('app.identity_kind', ${kind}, true), set_config('app.identity_lookup', ${v}, true)`;
    const rows = await tx<{ tenant_id: string; user_id: string }[]>`
      SELECT tenant_id, user_id FROM sign_in_identities WHERE kind = ${kind} AND value = ${v} ${tenant ? tx`AND tenant_id = ${tenant}` : tx``}
      ORDER BY address IS NOT DISTINCT FROM ${kind === "email" ? value.trim() : null} DESC, tenant_id, user_id LIMIT ${MAX_CANDIDATES + 1}`;
    return { candidates: rows.slice(0, MAX_CANDIDATES).map((r) => ({ t: r.tenant_id, u: r.user_id })), more: rows.length > MAX_CANDIDATES };
  }) as Promise<{ candidates: Candidate[]; more: boolean }>;
}

export interface Membership {
  tenantId: string;
  userId: string;
  workspace: { id: string; name: string };
  /** The address exactly as stored: what a sign-in email goes to, and what a code or link proves. */
  email: string;
  name: string;
  role: string;
  /** False when the workspace's owner turned password sign-in off. */
  passwordAllowed: boolean;
  passwordHash: string | null;
  /** False when the workspace's owner turned single sign-on off; `ssoDomains` narrows it (empty: any). */
  ssoAllowed: boolean;
  ssoDomains: string[];
  oidc: { issuer: string; subject: string } | null;
}

/** The memberships among `candidates` that can sign in now: the member is active and their role not archived. One transaction per workspace. */
export async function activeMemberships(candidates: Candidate[]): Promise<Membership[]> {
  const seen = new Set<string>();
  const out: Membership[] = [];
  for (const c of candidates.slice(0, MAX_CANDIDATES)) {
    if (seen.has(`${c.t}:${c.u}`)) continue;
    seen.add(`${c.t}:${c.u}`);
    const m = await withTenant(c.t, async (tx) => {
      const [r] = await tx<{ email: string; name: string; role: string; workspace: string; password_sign_in: boolean; password_hash: string | null;
        sso_sign_in: boolean; sso_allowed_domains: string[]; oidc_issuer: string | null; oidc_subject: string | null }[]>`
        SELECT u.email::text, u.name, r.key AS role, t.name AS workspace, t.password_sign_in, c.password_hash, t.sso_sign_in, t.sso_allowed_domains,
               c.oidc_issuer, c.oidc_subject
        FROM users u JOIN roles r ON r.tenant_id = u.tenant_id AND r.id = u.role_id CROSS JOIN tenants t
        LEFT JOIN member_credentials c ON c.tenant_id = u.tenant_id AND c.user_id = u.id
        WHERE u.id = ${c.u} AND u.disabled_at IS NULL AND r.archived_at IS NULL`;
      return r;
    });
    if (!m) continue;
    out.push({
      tenantId: c.t, userId: c.u, workspace: { id: encodeId("ws", c.t), name: m.workspace }, email: m.email, name: m.name, role: m.role,
      passwordAllowed: m.password_sign_in, passwordHash: m.password_hash, ssoAllowed: m.sso_sign_in, ssoDomains: m.sso_allowed_domains,
      oidc: m.oidc_issuer && m.oidc_subject ? { issuer: m.oidc_issuer, subject: m.oidc_subject } : null,
    });
  }
  return out;
}
