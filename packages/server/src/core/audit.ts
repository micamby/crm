import type { Tx } from "../db/pool.js";
import { encodeId, uuidv7 } from "../lib/ids.js";
import type { Ctx } from "./context.js";

export interface AuditEntry {
  action: string;
  objectType?: string | null;
  recordId?: string | null;
  /** Never put confidential or restricted values here: names of changed fields, not their values. */
  details?: Record<string, unknown>;
}

/**
 * Writes an audit row in the caller's transaction, so it commits or rolls back with the change.
 * A browser session has no key, so its ID goes in `details.session`; an app connected over OAuth
 * names its grant and client in `details.oauth_grant` and `details.oauth_client` (the row's hashed
 * columns are fixed). Never a token.
 */
export async function audit(tx: Tx, ctx: Ctx, entry: AuditEntry): Promise<void> {
  const details = { ...entry.details, ...(ctx.session ? { session: encodeId("ses", ctx.session.id) } : {}),
    ...(ctx.oauth ? { oauth_grant: encodeId("ogr", ctx.oauth.grantId), oauth_client: ctx.oauth.clientId } : {}) };
  await tx`
    INSERT INTO audit_log (tenant_id, id, actor_type, actor_id, key_id, surface, action, object_type, record_id, request_id, details)
    VALUES (${ctx.tenantId}, ${uuidv7()}, ${ctx.actor.type}, ${ctx.actor.id}, ${ctx.keyId}, ${ctx.surface},
            ${entry.action}, ${entry.objectType ?? null}, ${entry.recordId ?? null}, ${ctx.requestId},
            ${tx.json(details as never)})`;
}
