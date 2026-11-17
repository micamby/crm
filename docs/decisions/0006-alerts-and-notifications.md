# 0006: Alerts, deadlines and notification delivery

Status: accepted (2026-11-01)

## Decision

**Two kinds of alert rule, one model.** An alert rule watches one object.

- **Event rules** fire when a matching change happens (`deal.created`, `contact.updated` with `changed_fields`, `deal.stage_changed`, …). They are evaluated by the event processor (ADR 0005), right after automations.
- **Time rules** fire when a deadline passes:
  - `inactive`: no update and no logged activity for N days. The deadline is `max(updated_at, latest activity about the record) + N days`.
  - `field_passed`: a date or date-time field has passed, plus an optional offset in hours.

**Materialized deadlines**. `rule_deadlines (rule, record, due_at)` holds one row per time rule and record. It is kept current from the event stream: record changes, archives, and activities logged against a record. New or reshaped rules are backfilled by the scheduler in keyset pages of 1,000. The scheduler reads only due rows through an index, recomputes each deadline from the record as it is now (so a record touched since then is pushed out rather than fired), re-checks the condition, then fires. A fired deadline is deleted, or pushed out by the cooldown. The scheduler never scans whole tables.

**Conditions** use the query compiler, as automations do, so an alert filter means exactly what the same filter means in `query_records`.

**Dedupe.** A partial unique index allows one open notification per (rule, record, recipient). While one is open, nothing new is created. With `cooldown_hours`, an open notification is re-fired (back to unread, `fire_count` + 1, delivered again) once the cooldown passes, and after resolution a new one also waits for the cooldown. Without a cooldown, a time rule fires once per record until the record changes again.

**Scope.** Workspace rules (admin) notify the record's owner (a task's assignee) and/or named members, and can send `alert.fired` events to webhooks. Personal rules (ops) notify only their creator and, by default, only cover records they own (`mine_only`). Service accounts have no inbox.

**Delivery.** The inbox is the notification table. Email follows each member's preferences: per severity `immediate`, `digest` or `off` (default: warning and critical immediate, info off), a digest hour and time zone, and quiet hours (critical ignores them). `notification_deliveries` is the per-notification delivery log and the email queue: 5 attempts with backoff, then `failed`. Daily digests group a member's pending digest deliveries into one email. Webhook delivery reuses the automation pipeline: firing emits an `alert.fired` outbox event, which goes to the rule's webhooks and to any `alert.*` subscriptions, with the full record (restricted values redacted).

**Email** is one SMTP adapter (nodemailer, pinned) behind a `Mailer` interface. Self-hosters point `SMTP_URL` at any provider; a future hosted service would use Amazon SES over SMTP. Without `SMTP_URL`, email deliveries are logged as skipped and the inbox and webhooks still work. STARTTLS is required except to localhost.

**Restricted data.** Titles, emails and backtest samples are built by reading records without `restricted:read`, so restricted values can never reach a notification, email or sample.

**Automations** gain a `notify` action (inbox plus email per preferences). It replaces the planned `send_email` action: same outcome, and it respects member preferences.

**Backtest.** Event rules replay the 90-day event history. Time rules compute every record's current deadline (up to 20,000 records) and report how many would notify the moment the rule is saved and how many became due in the window. Both are approximate because conditions are checked against records as they are now, and the response says so.

## Consequences

- Times are taken from the app clock throughout scheduling and email, so a skew between the app and database clocks cannot hold back a delivery.
- Snoozed notifications return to unread when the snooze ends (the scheduler flips them).
- Slack, SMS and push channels fit behind the same delivery table later (`channel` column).
