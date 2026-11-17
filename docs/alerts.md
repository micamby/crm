# Alerts and notifications

hl-crm-db watches your data and tells the right person, so agents and people respond to it instead of polling.

## Rules

| Trigger | Example |
|---|---|
| `{"type": "event", "event": "deal.created"}` | A new deal over $10k (add a condition on `amount`) |
| `{"type": "event", "event": "contact.updated", "changed_fields": ["job_title"]}` | A contact's title changed |
| `{"type": "inactive", "days": 14}` | An open deal with no update or logged activity for 14 days |
| `{"type": "field_passed", "field": "due_at"}` | A task is overdue |
| `{"type": "field_passed", "field": "expected_close_date", "offset_hours": -72}` | Three days before a deal's expected close date |

`condition` narrows a rule with the same filter language as `query_records`, for example `{"field": "status", "op": "eq", "value": "open"}`. `severity` is `info`, `warning` (default) or `critical`. `cooldown_hours` re-notifies every N hours while the rule still applies; without it, a rule notifies once per record until the record changes.

- **Workspace alerts** (admin MCP `create_workspace_alert`, `POST /v1/alerts`; needs the `alerts:manage` permission, see [`docs/permissions.md`](permissions.md)) notify the record's owner (a task's assignee) and/or named members, and can send `alert.fired` webhooks.
- **Personal alerts** (ops MCP `create_personal_alert`, `POST /v1/me/alerts`) notify only you, and by default only for records you own.

Creating a rule through MCP is a dry run by default. It returns a plain-language summary and a **backtest**: how often the rule would have fired over the last 30 days (up to 90), with sample records. For time rules, the backtest also says how many records would notify as soon as the rule is saved.

## The inbox

Recipients must be active members whose role can read the alert's object, because a notification names the record. Their role must also be able to read everything the rule depends on (its condition, `changed_fields`, the field an event is about, a `field_passed` field, and activities for `inactive`), because a notification that arrives only when the rule matches would otherwise reveal those values. Anyone else is skipped, both when the alert fires and (for the object) when its email is due (a member disabled or moved to such a role after the alert fired gets no email). Saving an alert, or an automation `notify` action, that names such a member returns a warning. See [object and field access](permissions.md#what-is-enforced-and-how).

Each fired alert creates one notification per recipient: `unread`, `acknowledged`, `snoozed` (until a time) or `resolved`. While a notification is open, the same rule and record never create another one.

Ask your agent "what needs my attention?" It calls `get_attention_summary`, which returns open alerts ordered by severity, then overdue tasks, each with its record. Then `acknowledge_notification`, `snooze_notification` or `resolve_notification`.

## Email

`set_notification_preferences` (or `PATCH /v1/me/notification-preferences`):

```json
{
  "email": { "info": "off", "warning": "immediate", "critical": "immediate" },
  "digest_hour": 8,
  "timezone": "America/Denver",
  "quiet_hours": { "start": "22:00", "end": "07:00" }
}
```

`digest` collects that severity into one email at `digest_hour`. Quiet hours hold immediate email until they end; critical alerts ignore them. Emails never include restricted field values. Each notification's delivery log is in `GET /v1/me/notifications/{id}`.

Email needs `SMTP_URL` and `SMTP_FROM` on the worker (see `.env.example`). Without it, the inbox and webhooks still work.

## Webhooks

Add `webhooks: ["whk_…"]` to a workspace alert, or subscribe a webhook to `alert.*`. The `alert.fired` payload carries the record and the alert, so a receiving agent can act without another lookup:

```json
{
  "type": "alert.fired",
  "object": "deal",
  "record_id": "deal_…",
  "record": { "name": "Quiet deal", "amount": 12000, "owner": "usr_…", "…": "…" },
  "data": {
    "alert": { "id": "alr_…", "name": "Deal untouched for 14 days", "severity": "warning", "scope": "workspace", "trigger": { "type": "inactive", "days": 14 } },
    "title": "Deal untouched for 14 days: Quiet deal",
    "reason": "No activity since 2026-11-15T…",
    "notifications": ["ntf_…"],
    "recipients": ["usr_…"]
  }
}
```

Signatures and retries are as in [`webhooks.md`](webhooks.md).

## Automations can notify too

The `notify` action puts a message in members' inboxes (and email, per their preferences): `{"type": "notify", "title": "New big deal: {{record.name}}", "recipients": {"record_owner": true}}`.

## Alerts or automations?

An **alert** tells people about a record: it only notifies (inbox, email per each member's preferences, alert webhooks), it has time triggers built in ("no activity for 14 days", "due date passed", with cooldowns and one open notification per record), a backtest, and members can make personal alerts for themselves. An **automation** does work: it changes and creates records, calls HTTP endpoints, sends email to members or (when the workspace allows it) other addresses, on record events, on a clock schedule or on request, and only members with `automations:manage` set them up. Use an alert for "tell me when…", an automation for "when…, do…". Both skip recipients whose role can't read what the rule depends on. Automation schedules run on the clock (every N minutes, daily, weekly, monthly), not per record: for "N days after something happened to this record", use an alert's time trigger. See [automations.md](automations.md).
