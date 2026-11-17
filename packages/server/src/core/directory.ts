import type { Tx } from "../db/pool.js";
import { forbidden, unprocessable } from "../lib/errors.js";
import { encodeId } from "../lib/ids.js";
import { canObject, fieldAccess } from "./access.js";
import type { Ctx } from "./context.js";
import { escapeLike, UUID } from "./query.js";
import { isModuleOn, loadSchema } from "./schema.js";

// ----------------------------------------------------------------------------------------------
// Member directory

export const DIRECTORY_LIMITS = { defaultPage: 100, maxPage: 500 } as const;

/**
 * Active users for owner and assignee pickers: ID, name and email, the same as describe_object lists
 * under `users`. Roles, sign-in facts, service accounts and disabled users are never listed. A user is
 * what an owner-like field holds, so the directory is for callers who can read at least one field that
 * refers to users (owner, assignee, …); a role that hides all of them gets 403.
 */
export async function listUsers(tx: Tx, ctx: Ctx, opts: { q?: string; limit?: number; cursor?: string } = {}) {
  const schema = await loadSchema(tx);
  const readsUsers = [...schema.objects.values()].some((o) => isModuleOn(schema, o) && canObject(ctx, o, "read")
    && o.fields.some((f) => f.type === "relation" && f.options.to === "user" && fieldAccess(ctx, o, f) !== "none"));
  if (!readsUsers) throw forbidden("This key can't read any field that refers to users (such as owner), so it can't list them");
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) throw unprocessable("limit must be a positive whole number");
  const limit = Math.min(opts.limit ?? DIRECTORY_LIMITS.defaultPage, DIRECTORY_LIMITS.maxPage);
  const q = opts.q?.trim().toLowerCase() ?? "";
  if (q.length > 200) throw unprocessable("q is too long");
  let after: { n: string; id: string } | null = null;
  if (opts.cursor !== undefined) {
    try {
      after = JSON.parse(Buffer.from(opts.cursor, "base64url").toString("utf8")) as { n: string; id: string };
    } catch {
      after = null;
    }
    if (!after || typeof after.n !== "string" || after.n.length > 1000 || typeof after.id !== "string" || !UUID.test(after.id)) {
      throw unprocessable("Invalid cursor; start again without one");
    }
  }
  const like = `${escapeLike(q)}%`;
  const rows = await tx<{ id: string; name: string; email: string }[]>`
    SELECT id, name, email::text AS email FROM users
    WHERE disabled_at IS NULL
      AND (${q} = '' OR lower(name) LIKE ${like} OR lower(email::text) LIKE ${like} OR lower(name) LIKE ${`% ${escapeLike(q)}%`})
      AND (${after?.n ?? null}::text IS NULL OR (name, id) > (${after?.n ?? ""}, ${after?.id ?? "00000000-0000-0000-0000-000000000000"}::uuid))
    ORDER BY name, id LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    data: page.map((u) => ({ id: encodeId("usr", u.id), name: u.name, email: u.email })),
    next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ n: last.name, id: last.id })).toString("base64url") : null,
  };
}

// ----------------------------------------------------------------------------------------------
// Preferences

export const PREFERENCE_LIMITS = { keys: 100, valueBytes: 8_192, totalBytes: 65_536 } as const;
const KEY = /^[a-z][a-z0-9_.:-]{0,63}$/;
const API_KEY = /hlcrm_(live|test)_/;

const member = (ctx: Ctx) => {
  if ((ctx.actor.type !== "user" && ctx.actor.type !== "service_account") || !ctx.actor.id) throw unprocessable("Preferences need a key that belongs to a member");
  return { type: ctx.actor.type, id: ctx.actor.id };
};

/** The caller's own preferences: UI state such as column widths or the last view opened. Never for secrets. */
export async function getPreferences(tx: Tx, ctx: Ctx): Promise<Record<string, unknown>> {
  const m = member(ctx);
  const rows = await tx<{ key: string; value: unknown }[]>`
    SELECT key, value FROM member_preferences WHERE member_type = ${m.type} AND member_id = ${m.id} ORDER BY key`;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Sets the keys given (null removes one) and returns them all. Keys, sizes and the key count are capped. */
export async function setPreferences(tx: Tx, ctx: Ctx, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const m = member(ctx);
  const entries = Object.entries(input);
  if (entries.length > PREFERENCE_LIMITS.keys) throw unprocessable(`At most ${PREFERENCE_LIMITS.keys} preferences`);
  for (const [k, v] of entries) {
    if (!KEY.test(k)) throw unprocessable(`"${k.slice(0, 80)}" is not a valid preference key: lowercase letters, digits and _ . : -, starting with a letter, at most 64 characters`);
    if (v !== null && API_KEY.test(JSON.stringify(v))) throw unprocessable(`Preference "${k}" looks like it holds an API key; preferences are not for secrets`);
  }
  // Sizes as the database CHECK measures them (each value's jsonb text, longer than JSON.stringify), so too big is a 422, not a 500.
  const set = entries.filter(([, v]) => v !== null);
  const sizes = set.length === 0 ? [] : await tx<{ n: number }[]>`
    SELECT octet_length(x::text)::int AS n FROM jsonb_array_elements(${tx.json(set.map(([, v]) => v) as never)}::jsonb) WITH ORDINALITY AS e(x, i) ORDER BY i`;
  sizes.forEach((r, i) => {
    if (r.n > PREFERENCE_LIMITS.valueBytes) throw unprocessable(`Preference "${set[i]![0]}" is larger than ${PREFERENCE_LIMITS.valueBytes} bytes`);
  });
  // Serialises this member's writes, so the caps hold under concurrent requests.
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`prefs:${ctx.tenantId}:${m.type}:${m.id}`}))`;
  for (const [k, v] of entries) {
    if (v === null) await tx`DELETE FROM member_preferences WHERE member_type = ${m.type} AND member_id = ${m.id} AND key = ${k}`;
    else {
      await tx`INSERT INTO member_preferences (tenant_id, member_type, member_id, key, value) VALUES (${ctx.tenantId}, ${m.type}, ${m.id}, ${k}, ${tx.json(v as never)})
        ON CONFLICT (tenant_id, member_type, member_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    }
  }
  const all = await getPreferences(tx, ctx);
  if (Object.keys(all).length > PREFERENCE_LIMITS.keys) throw unprocessable(`At most ${PREFERENCE_LIMITS.keys} preferences; remove some (set them to null) first`);
  const [total] = await tx<{ n: number }[]>`
    SELECT coalesce(sum(octet_length(value::text)), 0)::int AS n FROM member_preferences WHERE member_type = ${m.type} AND member_id = ${m.id}`;
  if (total!.n > PREFERENCE_LIMITS.totalBytes) throw unprocessable(`Preferences can hold at most ${PREFERENCE_LIMITS.totalBytes} bytes in all`);
  return all;
}
