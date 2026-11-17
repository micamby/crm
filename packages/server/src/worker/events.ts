import { randomUUID } from "node:crypto";
import { alertWebhooks, handleEventForAlerts } from "../core/alerts.js";
import { runAutomationsForEvent } from "../core/automations.js";
import { systemCtx } from "../core/context.js";
import {
  attempt, buildRequest, enqueueDelivery, matchesPattern, recordForPayload, recordAttempt,
  type DeliveryRow, type EventRow, type WebhookRow,
} from "../core/webhooks.js";
import { withTenant } from "../db/tx.js";
import { ApiError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

/** Delay before each retry of a failed event: 6 attempts in all over about 4 hours. */
export const EVENT_RETRY_DELAYS_S = [10, 60, 300, 1800, 3 * 3600];
export const EVENT_MAX_ATTEMPTS = EVENT_RETRY_DELAYS_S.length + 1;

/** What the tenant sees as an event's last_error: our own messages, or just the error code. */
function eventFailureReason(err: unknown): string {
  if (err instanceof ApiError) return err.message.slice(0, 300);
  const code = (err as { code?: unknown })?.code;
  return `internal error${typeof code === "string" && /^[A-Z0-9_]{1,40}$/i.test(code) ? ` (${code})` : ""}`;
}

/**
 * Event processing: claims due outbox events for one tenant (FOR UPDATE SKIP LOCKED, so several
 * workers can run), runs automations, queues webhook deliveries for subscriptions, and marks the
 * events processed, all in one transaction. Each event is handled in a savepoint, so a failing
 * event is rolled back on its own: it is retried with backoff (other events carry on past it, so
 * one poisoned event cannot block the queue), and after EVENT_MAX_ATTEMPTS it is dead-lettered
 * (dead_at set, logged, and listed by GET /v1/events?status=dead) rather than silently dropped.
 */
export async function processEvents(tenantId: string, batch = 100, until = Infinity): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const events = await tx<(EventRow & { attempts: number })[]>`
      SELECT id, type, object_type, record_id, occurred_at, actor_type, actor_id, surface, data, causation_depth, automation_id, attempts
      FROM outbox_events WHERE processed_at IS NULL AND dead_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY occurred_at, id LIMIT ${batch} FOR UPDATE SKIP LOCKED`;
    if (events.length === 0) return 0;
    const webhooks = await tx<WebhookRow[]>`SELECT * FROM webhooks WHERE archived_at IS NULL AND cardinality(events) > 0`;
    const ctx = systemCtx(tenantId, "events");
    const done: string[] = [];
    let handled = 0;
    for (const e of events) {
      // Past the tenant's time for this pass: the rest stay unprocessed (and unlocked at commit) for the next pass.
      if (handled > 0 && Date.now() >= until) break;
      handled++;
      try {
        await tx.savepoint(async (sp) => {
          await runAutomationsForEvent(sp, tenantId, e);
          await handleEventForAlerts(sp, tenantId, e);
          const ruleHooks = new Set(await alertWebhooks(sp, e));
          if (ruleHooks.size) {
            const targets = await sp<WebhookRow[]>`SELECT * FROM webhooks WHERE id = ANY(${[...ruleHooks]}::uuid[]) AND archived_at IS NULL`;
            for (const w of targets) await enqueueDelivery(sp, ctx, { webhook: w, event: e, consumer: "alert" });
          }
          const subs = webhooks.filter((w) => w.events.some((p) => matchesPattern(p, e.type)));
          if (subs.length) {
            const plain = await recordForPayload(sp, ctx, e, false);
            for (const w of subs) {
              const rec = w.include_restricted ? await recordForPayload(sp, ctx, e, true) : plain;
              await enqueueDelivery(sp, ctx, { webhook: w, event: e, consumer: "subscription", record: rec });
            }
          }
        });
        done.push(e.id);
      } catch (err) {
        const attempts = e.attempts + 1;
        const dead = attempts >= EVENT_MAX_ATTEMPTS;
        const delay = EVENT_RETRY_DELAYS_S[Math.min(attempts - 1, EVENT_RETRY_DELAYS_S.length - 1)]! * (0.8 + Math.random() * 0.4);
        await tx`UPDATE outbox_events SET attempts = ${attempts}, last_error = ${eventFailureReason(err)},
                   next_attempt_at = ${dead ? null : new Date(Date.now() + delay * 1000)}, dead_at = ${dead ? new Date() : null}
                 WHERE id = ${e.id}`;
        const line = { tenantId, event: e.id, type: e.type, attempt: attempts, err: (err as Error).message };
        if (dead) logger.error(line, "event dead-lettered after its last attempt; its automations and webhooks did not run");
        else logger.warn(line, "event processing failed; will retry");
      }
    }
    if (done.length) await tx`UPDATE outbox_events SET processed_at = now() WHERE id = ANY(${done}::uuid[])`;
    return handled;
  });
}

/** How long one tenant's events may take in one pass of the events loop. Mutable for tests. */
export const EVENTS_TENANT_BUDGET_MS = { value: 2_000 };

/**
 * One pass of the events loop over every tenant. Each tenant gets at most EVENTS_TENANT_BUDGET_MS (checked
 * between events) and ten batches; what is left waits for the next pass, so a tenant whose automations are
 * slow or whose backlog is long delays the others by that much at most, not until its queue is empty.
 * Tenants take turns going first.
 */
let eventsRotation = 0;
export async function processEventsRound(tenants: string[]): Promise<number> {
  let total = 0;
  const from = tenants.length ? eventsRotation++ % tenants.length : 0;
  for (const t of [...tenants.slice(from), ...tenants.slice(0, from)]) {
    const until = Date.now() + EVENTS_TENANT_BUDGET_MS.value;
    for (let pass = 0; pass < 10 && Date.now() < until; pass++) {
      const n = await processEvents(t, 100, until);
      total += n;
      if (n === 0) break;
    }
  }
  return total;
}

/** Long enough for one send (DNS + request timeouts) with room to spare. Renewed before each send. */
const LEASE_SECONDS = 60;

/**
 * Sends due webhook deliveries for one tenant. Deliveries are leased in a short transaction with
 * a lease token; each one is then, in turn, re-leased and signed in a short transaction, sent
 * outside any transaction (so a slow endpoint holds no locks or connections), and recorded as
 * soon as it finishes, guarded by the token. A lease therefore only has to outlast one send, and a
 * worker whose lease lapsed cannot record over (or send after) the worker that took over.
 * Endpoints are sent to in parallel; each endpoint gets up to PER_ENDPOINT deliveries per pass,
 * one at a time and oldest first, stopping at its first failure. Paused (circuit-open) and
 * disabled endpoints are skipped, except for test deliveries. Returns how many deliveries were
 * leased, so the caller can loop while there is a backlog.
 */
const PER_ENDPOINT = 5;

export async function deliverDue(tenantId: string, limit = 100): Promise<number> {
  const lease = randomUUID();
  const claimed = await withTenant(tenantId, (tx) => tx<DeliveryRow[]>`
    WITH due AS (
      SELECT id FROM (
        SELECT d.id, row_number() OVER (PARTITION BY d.webhook_id ORDER BY d.next_attempt_at, d.id) AS n
        FROM webhook_deliveries d JOIN webhooks w ON w.tenant_id = d.tenant_id AND w.id = d.webhook_id
        WHERE (d.status = 'pending' OR (d.status = 'sending' AND d.locked_until < now()))
          AND d.next_attempt_at <= now() AND w.archived_at IS NULL
          AND (d.consumer LIKE 'test:%' OR (w.enabled AND (w.circuit_open_until IS NULL OR w.circuit_open_until < now())))
      ) ranked WHERE n <= ${PER_ENDPOINT}
      LIMIT ${limit}
    )
    UPDATE webhook_deliveries d SET status = 'sending', locked_until = now() + make_interval(secs => ${LEASE_SECONDS}), lease_token = ${lease}::uuid
    FROM due WHERE d.id = due.id AND (d.status = 'pending' OR (d.status = 'sending' AND d.locked_until < now()))
    RETURNING d.*`);
  if (claimed.length === 0) return 0;
  const byHook = new Map<string, DeliveryRow[]>();
  for (const d of claimed.sort((a, b) => a.next_attempt_at.getTime() - b.next_attempt_at.getTime() || (a.id < b.id ? -1 : 1))) {
    byHook.set(d.webhook_id, [...(byHook.get(d.webhook_id) ?? []), d]);
  }
  await Promise.all([...byHook.values()].map(async (list) => {
    for (const [i, d] of list.entries()) {
      const prepared = await prepareSend(tenantId, d, lease);
      if (!prepared) continue; // lease lost, or the webhook is gone
      const out = await attempt(prepared.w.url, prepared.req);
      const recorded = await withTenant(tenantId, (tx) => recordAttempt(tx, prepared.w, d, out, lease));
      if (!out.ok) {
        logger.info({ tenantId, delivery: d.id, attempt: d.attempts + 1, status: out.status, code: out.code, recorded }, "webhook delivery failed");
        // Release the rest untried so they keep their order and attempt counts, and hold the
        // endpoint's queue briefly behind the failed delivery instead of hammering it.
        const rest = list.slice(i + 1).map((r) => r.id);
        if (rest.length) {
          await withTenant(tenantId, (tx) => tx`
            UPDATE webhook_deliveries SET status = 'pending', locked_until = NULL, lease_token = NULL, next_attempt_at = now() + interval '30 seconds'
            WHERE id = ANY(${rest}::uuid[]) AND lease_token = ${lease}::uuid`);
        }
        return;
      }
    }
  }));
  return claimed.length;
}

/** Renews the lease and signs the request (fresh timestamp, current webhook row), or null if the lease was lost. */
async function prepareSend(tenantId: string, d: DeliveryRow, lease: string) {
  return withTenant(tenantId, async (tx) => {
    const [held] = await tx`
      UPDATE webhook_deliveries SET locked_until = now() + make_interval(secs => ${LEASE_SECONDS})
      WHERE id = ${d.id} AND status = 'sending' AND lease_token = ${lease}::uuid RETURNING 1`;
    if (!held) return null;
    const [w] = await tx<WebhookRow[]>`SELECT * FROM webhooks WHERE id = ${d.webhook_id} AND archived_at IS NULL`;
    if (!w) return null;
    return { w, req: await buildRequest(tx, tenantId, w, d) };
  });
}

/** Drops processed events, runs and finished deliveries older than the 90-day retention window, and spent confirm tokens once they have expired (they can't be replayed then anyway). */
export async function pruneHistory(tenantId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx`DELETE FROM webhook_deliveries WHERE created_at < now() - interval '90 days' AND status IN ('succeeded', 'dead')`;
    await tx`DELETE FROM automation_runs WHERE started_at < now() - interval '90 days' AND status NOT IN ('queued', 'running')`;
    await tx`DELETE FROM automation_usage WHERE window_start < now() - interval '2 days'`;
    await tx`DELETE FROM outbox_events WHERE (processed_at IS NOT NULL OR dead_at IS NOT NULL) AND occurred_at < now() - interval '90 days'`;
    await tx`DELETE FROM confirm_tokens WHERE expires_at < now()`;
  });
}
