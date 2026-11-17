import type { Tx } from "../db/pool.js";
import { uuidv7 } from "../lib/ids.js";
import type { Ctx } from "./context.js";

/** Writes an outbox event in the caller's transaction (transactional outbox). Workers deliver it later. */
export async function emit(
  tx: Tx,
  ctx: Ctx,
  event: { type: string; objectType?: string; recordId?: string; data?: Record<string, unknown> },
): Promise<void> {
  await tx`
    INSERT INTO outbox_events (tenant_id, id, type, object_type, record_id, actor_type, actor_id, surface, data, causation_depth, automation_id)
    VALUES (${ctx.tenantId}, ${uuidv7()}, ${event.type}, ${event.objectType ?? null}, ${event.recordId ?? null},
            ${ctx.actor.type}, ${ctx.actor.id}, ${ctx.surface}, ${tx.json((event.data ?? {}) as never)},
            ${ctx.causationDepth ?? 0}, ${ctx.automationId ?? null})`;
}
