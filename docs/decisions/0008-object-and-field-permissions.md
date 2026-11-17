# 0008: Object and field permissions on custom roles

Status: accepted (2026-11-13)

## Context

ADR 0007 gave workspaces roles built from a fixed permission catalog, with one stated limit: `records:read`, `records:write` and `records:archive` applied to every object. A workspace could not say "support reads contacts and nothing else", "assistants never see deals" or "nobody outside finance sees the margin field". The only field-level control was the restricted classification, which is about encryption and `restricted:read`, not about who works with which data.

A route-level check can no longer carry the decision either: a role may read contacts without holding `records:read`.

## Decision

**Role permissions stay the default; rules override per object and per field.** `records:read/write/archive` remain a role's default for every object. A custom role can add:

- **Object rules:** for one object, each of read, write and archive is allow, deny or inherit. They work in both directions (a grant on a role without the permission, a deny on a role with it). On an object with a rule, write needs read and archive needs write.
- **Field rules:** for one field, `none` (not visible, not writable) or `read` (not writable). They only take away; a field never gets more than its object.

`restricted:read`, hidden fields and archived fields work as before, on top.

**Stored in tables keyed by IDs.** `role_object_permissions` and `role_field_permissions` hold one row per rule, with composite foreign keys to the role and to the object or field, forced RLS like every tenant table, and nullable booleans for "inherit". IDs, not names, so a renamed field keeps its rule. A JSON column on the role was simpler to write but could not have foreign keys or follow renames.

**Loaded with the role, cached by version.** Authentication already reads the role on every request; it now also reads `roles.access_version`. Triggers on the two rule tables set it from a sequence whenever a rule row is inserted, changed or deleted, so a change made outside the app (a manual fix in SQL, a later migration) counts too, and a version is never reused after a rollback. The rules are cached per role and version (one query on a miss), so a change takes effect on the next request in every process, and a request costs no extra query when nothing changed. Rules being checked before they are saved are never cached.

**Key scopes still only narrow.** An object rule can grant only what the key's scopes unlock: a key without `ops:write` can't write even where its role's rule allows it. A grant does make a scope usable for a role (an `ops:read` key for a role that reads only contacts).

**Enforced in the record layer, not only in routes.** The route gate admits a key that has the needed action on at least one object. `core/access.ts` answers `canObject` and `fieldAccess`, and the record layer, the query compiler, search, operations, events, notifications and alerts call it. Contexts with no rules (system work, the worker, automations, alert evaluation) follow their permissions exactly as before. Where internal work acts for a member, it uses that member's role: notification recipients, the titles and email lines they get, automation `notify` placeholders, and personal alerts.

**Inference is treated as access.** A filter, sort or relation path on something the caller can't read is refused, because which records match reveals values. Search can't use the precomputed search text for an object with hidden fields (it holds every field), so it matches only the readable text fields there, over a bounded window of the newest records. Linking a relation needs read on the target, so a write can't test whether an ID exists. Event payloads lose unreadable fields. Record counts are given only for readable objects. Lists the server builds for the caller (`/v1/me/tasks`, overdue tasks in `/v1/me/attention`) don't filter or sort on a field the caller can't read. A notification is itself an inference: it arrives only when its rule matches, so every recipient's role must be able to read what the rule depends on (condition, changed fields, the event's field, a `field_passed` field, activities for `inactive`); recipients who can't are skipped when it fires, and named in a warning when it is saved.

**Copies follow the source.** The record layer checked every read, but the platform also copies values: a contact's account into a new lead, a lead's account into the deal it becomes, names into a default deal name, and (before this decision was revised) deal names, task titles and interests into history activity subjects. The reader of a copy can have different rules than the source, so a copy made on a caller's behalf takes only what that caller can read on the source, and history activities have generic subjects and link to the records they are about instead; their `related` list names those records as each reader's role sees them. Once made, a copy is the target record's data. The route-wide test uses sentinels in standard fields on every object the operations touch, with the operations first run by an unrestricted member, so a new copy path shows up there.

**Schema metadata stays visible.** Object and field names are not data, and an agent needs them to understand an error. Every object and field is listed to anyone who can read the schema, with the caller's access next to it. Sensitive admin metadata is unchanged.

**Roles that run work with full access must have it.** Automations, webhook payloads and alert backtests read and write records with full access, and schema management shows per-field value counts (archiving a field) and whether an object holds data (turning a module off). A role holding `automations:manage`, `webhooks:manage`, `alerts:manage` or `schema:manage` therefore can't have denying object rules or field rules; otherwise it could configure (or count) its way around its own limits. The app refuses such a role, and a deferred constraint trigger refuses it in the database.

**Escalation rules cover record access.** Creating, editing or assigning a role, and minting a key for another member, need the caller's own access to be at least as wide, per object and per field. Editing checks before and after.

**Operations check everything first.** Each operation checks the objects it reads and the objects and fields it writes before it looks anything up, so a refusal does no work and reveals nothing (whether a contact with an email exists is itself data). Bookkeeping the platform does as a consequence (lifecycle stage, history activities, stage history, a deal's probability from its stage) is not treated as the caller's write. User data is: `move_deal_stage` clears `lost_reason` only for a caller who can write it.

**Required fields.** If a required field without a default is not writable by a role, that role can't create the object's records; the error names the field and says a default would fix it. The alternative, letting the create through with the field empty, would break the rule the field exists for.

**Audited by name.** Rule changes are in `role.created` and `role.updated` as object and field names with their new values. Record values never appear.

## Consequences

- Admins can check their work with `GET /v1/roles/{id}/access`; callers see their own with `GET /v1/me/access`, and in `describe_object`, the schema summary and the schema document export (`access`, given when the caller's access is limited). CSV export and import (added with the CLI) follow the same rules: no column for a field the caller can't read, filters through the same guard, and import columns checked before anything is read. The access review shows each member's rules.
- Search on an object with hidden fields for the caller doesn't use the index and looks only at that object's 10,000 newest records; older ones can't be found by search for that role. A `read` rule changes nothing for search, events or titles.
- A caller can still see that a record changed (its `version`, `updated_at`, and `*.updated` events with the hidden fields removed), not what changed.
- Automation `notify` titles are filled per recipient when they fire; alert titles are rebuilt from the current record for members with hidden fields on its object, automation titles are not.
- A recipient can stop receiving an alert or automation notification because of a field rule, with no notice to them; the admin sees a warning when the rule is saved.
- History activities written before the generic subjects keep their old subjects (a deal name, task title or interest); they are not rewritten.
- The audit log is not filtered by record rules. Its details hold field names, plus a few values such as stage names, lifecycle stages and owner IDs, so `audit:read` should go to roles you would let see those.
- Rules are per object and per field. Record-level sharing ("only records I own") is a separate feature and not built.
- Migration 008 adds the two tables, `roles.access_version` with its sequence and triggers, and the constraint trigger. It changes no existing data, so existing roles behave exactly as before.
