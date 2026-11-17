# 0005: Events, webhooks and automations without a job library

Status: accepted (2026-11-01)

## Decision

**Queues are plain Postgres tables, not graphile-worker.** An early plan named graphile-worker. The MVP uses the tables it already needs instead:

- `outbox_events` is the event queue and the 90-day event history. The worker claims unprocessed rows with `FOR UPDATE SKIP LOCKED`, runs automations, queues subscription deliveries and marks the events processed, all in one transaction. Each event runs in a savepoint, so one bad event cannot block the rest.
- `webhook_deliveries` is the delivery queue and the customer-visible delivery log. Deliveries are leased (`status = 'sending'`, `locked_until`) in a short transaction and sent outside any transaction, so a slow endpoint holds no database locks.
- At-least-once, with duplicates suppressed where possible: `automation_runs` is unique on `(automation_id, event_id)` and `webhook_deliveries` on `(event_id, webhook_id, consumer)`, so re-running the worker is a no-op. A crash between sending and recording can still send a delivery twice, so receivers deduplicate on `webhook-id`.

This keeps Postgres the only dependency and avoids a second schema of job tables. Because of RLS, the worker visits each tenant in turn, which is fine at MVP scale (hundreds of tenants, one indexed query each per second). If that stops being fine, a non-RLS "tenants with work" hint table, like `tenant_directory`, is the next step.

**Webhooks use the Standard Webhooks format** (standardwebhooks.com): `webhook-id`, `webhook-timestamp` and `webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">`, with `whsec_` secrets. This meets T-OUT-2 (signature covers the timestamp; receivers reject anything older than 5 minutes) and lets receivers use existing verifier libraries. During secret rotation both secrets sign, space-separated, as the spec allows.

**Webhook secrets are never shown through MCP**, the same rule as API keys. The API shows them on create and rotate, and through `GET /v1/webhooks/{id}/secret`. Every reveal is audited.

**SSRF guard** (`lib/outbound.ts`): HTTPS only; no credentials in URLs; resolve the host, check every address against private, loopback, link-local, CGNAT, reserved, multicast and IPv4-in-IPv6 ranges, then connect to the checked address; no redirects; 5 s DNS and 10 s request timeouts; 64 KB response cap; `last_error` never holds the response body. Self-hosters who need internal targets can set `WEBHOOK_ALLOW_INSECURE_TARGETS=true`, which allows `http://` and private addresses but never cloud metadata addresses. The worker logs a warning at startup when it is on.

**Restricted data:** payloads carry the record as a key without `restricted:read` would see it. An endpoint can be granted restricted values (`include_restricted`), but only by a key that has `restricted:read`, and never through MCP. Changing the URL or events of such an endpoint, or replaying a delivery that carries those values, also needs `restricted:read`. Those values are stored encrypted beside the delivery and merged in at send time, so the delivery log never holds them in plaintext.

**Automations** run under their own identity (`actor_type = automation`, surface `automation`) with `ops:read` and `ops:write` only: no admin, no restricted values. Loop guards: an automation never reacts to its own changes; every event carries a `causation_depth`, and runs at depth 5 are skipped and logged; each automation has an hourly cap (default 100). Conditions use the query compiler, so they behave exactly like `query_records` filters.

**Phase 1 actions:** `send_webhook`, `update_record` (the triggering record) and `create_record` (with `{{record.field}}`, `{{today+Nd}}` placeholders). `send_email` comes with the SMTP adapter in a later phase.

## Consequences

- Event processing failures: an event whose automations or deliveries fail to queue is retried with backoff (6 attempts over about 4 hours), then dead-lettered (`dead_at`) and listed by `GET /v1/events?status=dead`. Other events carry on past it.
- Webhook retries: 8 attempts over about 22 hours (30 s, 2 m, 10 m, 30 m, 1 h, 3 h, 6 h, 12 h, ±20% jitter), then `dead`. Dead and successful deliveries can be replayed.
- Circuit breaker: after 10 consecutive failures an endpoint is paused for 10 minutes. Deliveries wait rather than burn attempts.
- Events, runs and finished deliveries are deleted after 90 days.
