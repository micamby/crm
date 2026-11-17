/**
 * Record access as the API reports it (GET /v1/me/access, GET /v1/roles/{id}/access, `access` in the
 * schema document): per object, read/write/archive and the fields a rule limits. See docs/permissions.md.
 */

export interface ObjectAccess {
  object: string;
  read: boolean;
  write: boolean;
  archive: boolean;
  rule?: { read: boolean | null; write: boolean | null; archive: boolean | null } | null;
  fields: Record<string, "none" | "read" | "write">;
  restricted_fields?: { field: string; values: "visible" | "redacted" }[];
}

/** What one object allows, e.g. "read, write" or "none". */
export const actions = (a: Pick<ObjectAccess, "read" | "write" | "archive">): string =>
  [a.read && "read", a.write && "write", a.archive && "archive"].filter(Boolean).join(", ") || "none";

/** Everything short of read, write and archive on every field of every object, e.g. ["deal: none", "contact.phone: read"]. Empty when unrestricted. */
export function limits(objects: ObjectAccess[]): string[] {
  const out: string[] = [];
  for (const o of objects) {
    if (!o.read || !o.write || !o.archive) out.push(`${o.object}: ${actions(o)}`);
    if (o.read) for (const [f, a] of Object.entries(o.fields)) out.push(`${o.object}.${f}: ${a}`);
  }
  return out;
}

/** A table row per object, for `roles get` and `schema describe`. */
export const accessRows = (objects: ObjectAccess[]) => objects.map((o) => ({
  object: o.object, access: actions(o), limited_fields: Object.entries(o.fields).map(([f, a]) => `${f}: ${a}`),
  restricted: (o.restricted_fields ?? []).map((r) => `${r.field} (${r.values})`),
}));
