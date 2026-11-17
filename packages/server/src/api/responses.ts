/**
 * Response shapes the routes declare, as JSON Schema (OpenAPI 3.1). Every route names one (a test
 * fails otherwise), and a test checks real responses of the main record routes against what they
 * declare, so the document a typed client is generated from can't silently drift from the server.
 * Shapes are open (additionalProperties) where the server may add fields later without breaking clients.
 */

export type JsonSchema = Record<string, unknown>;
export interface ResponseSpec {
  /** The success status (default 200). */
  status?: number;
  /** Another success status with the same shape: 200 for the dry run of a create that answers 201. */
  alsoStatus?: number;
  schema: JsonSchema;
  /** For non-JSON bodies (an export). */
  contentType?: string;
  description?: string;
}

export const ref = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });
export const nullable = (s: JsonSchema): JsonSchema => ({ anyOf: [s, { type: "null" }] });
const str: JsonSchema = { type: "string" };
const int: JsonSchema = { type: "integer" };
const bool: JsonSchema = { type: "boolean" };
const anyObject: JsonSchema = { type: "object", additionalProperties: true };
export const object = (properties: Record<string, JsonSchema>, required: string[] = Object.keys(properties)): JsonSchema =>
  ({ type: "object", properties, required, additionalProperties: true });
export const list = (items: JsonSchema): JsonSchema => ({ type: "array", items });
/** A closed object: every property listed, nothing else allowed. For small shapes that are stable by design (sign-in, sessions). */
export const strict = (properties: Record<string, JsonSchema>, required: string[] = Object.keys(properties)): JsonSchema =>
  ({ type: "object", properties, required, additionalProperties: false });

/** `{ data: … }`, the envelope of every JSON response except pages with extra keys and a few operation results. */
export const data = (s: JsonSchema = anyObject, status?: number): ResponseSpec => ({ schema: object({ data: s }), ...(status ? { status } : {}) });
export const dataList = (items: JsonSchema = anyObject): ResponseSpec => data(list(items));
export const plain = (s: JsonSchema, status?: number): ResponseSpec => ({ schema: s, ...(status ? { status } : {}) });

/** Components every document has. The authenticated document replaces Record with one schema per object. */
export const BASE_SCHEMAS: Record<string, JsonSchema> = {
  Problem: {
    type: "object", description: "An RFC 9457 problem document (application/problem+json)", additionalProperties: true,
    properties: { type: str, title: str, status: int, detail: str, code: str, request_id: str, errors: {} },
    required: ["type", "title", "status", "detail", "code"],
  },
  Record: {
    type: "object", description: "A record as the caller may see it: fields the caller can't read are absent", additionalProperties: true,
    properties: {
      id: str, object: str, display_name: str, version: int, created_at: { type: "string", format: "date-time" },
      updated_at: { type: "string", format: "date-time" }, archived_at: { type: "string", format: "date-time" }, included: { $ref: "#/components/schemas/Included" },
      merged_into: { type: "string", description: "On a record merged into another (archived): the record that now holds its references, the end of merge_chain" },
      merge_chain: { type: "array", items: str, description: "On a merged record: the survivors it went into, in order (A into B, then B into C: [B, C])" },
    },
    required: ["id", "object"],
  },
  Included: {
    type: "object", description: "Related records asked for with include, by relation field: null when the relation is empty",
    additionalProperties: nullable(object({ id: str, object: str, display_name: nullable(str) }, ["id", "display_name"])),
  },
  RecordPage: object({
    data: list(ref("Record")), next_cursor: nullable(str),
    total: { type: "integer", description: "With count: the matching records, exact up to 10,000" },
    total_capped: { type: "boolean", description: "With count: true when there are more than total" },
  }, ["data", "next_cursor"]),
  OpResult: object({ dry_run: bool, result: {}, would: list(str) }, ["dry_run", "result"]),
  Aggregate: object({
    data: list(object({
      group: { type: "object", additionalProperties: true, description: "Group key per group_by field: a value, null, or {id, display_name} for a relation" },
      count: int,
      values: { type: "object", additionalProperties: { anyOf: [{ type: "number" }, str, { type: "null" }] } },
      currency: { type: "string", description: "With a currency measure: the currency of every amount in this group" },
    }, ["group", "count", "values"])),
    group_by: list(object({ field: str, bucket: str }, ["field"])),
    measures: list(object({ key: str, op: str, field: nullable(str) })),
    truncated: { type: "boolean", description: "True when there are more groups than limit" },
    rows_capped: { type: "boolean", description: "True when more than 100,000 records matched: groups and totals cover only the 100,000 most recently updated" },
  }),
  View: object({
    id: str, object: nullable(str), name: str, shared: bool, owner: nullable(str), mine: bool,
    status: { type: "string", enum: ["ok", "unavailable", "broken"] }, problem: str,
    where: {}, sort: {}, columns: {}, group_by: {}, version: int, created_at: str, updated_at: str,
  }, ["id", "object", "name", "shared", "owner", "mine", "status", "version"]),
  DirectoryUser: object({ id: str, name: str, email: str }),
  CreatePreview: object({
    dry_run: { type: "boolean", const: true }, object: str,
    counts: object({ create: int, error: int }),
    rows: list(object({ index: int, action: { type: "string", enum: ["create", "error"] }, record: anyObject, reason: str, errors: {} }, ["index", "action"])),
  }),
  BulkResult: object({
    dry_run: bool, object: str, op: { type: "string", enum: ["update", "archive"] }, count: int,
    counts: { type: "object", additionalProperties: int, description: "Records per action: the op, skip and error" },
    rows: list(object({ id: str, action: { type: "string", enum: ["update", "archive", "skip", "error"] }, version: int, reason: str, errors: {} }, ["id", "action"])),
    sample: list(ref("Record")),
    confirm_token: { type: "string", description: "From a dry run with no errors: pass it back to run the same change. Single-use, 15 minutes, bound to the credential" },
    no_longer_matching: list(str), new_matches_not_changed: int,
  }, ["dry_run", "object", "op", "count", "counts", "rows"]),
  MergeResult: object({
    dry_run: bool, survivor: ref("Record"), merged: list(str), changes: {}, references: list(anyObject), not_filled: list(anyObject),
    confirm_token: { type: "string", description: "From a dry run: pass it back to apply the same merge. Single-use, 15 minutes, bound to the credential" },
  }, ["dry_run", "survivor", "merged"]),
  DuplicateGroups: object({
    object: str, scanned: int, window_full: bool, fuzzy_scanned: int,
    groups: list(object({ reason: anyObject, count: int, records: list(ref("Record")) })),
    more_groups: bool, skipped_rules: list({}),
  }, ["object", "scanned", "window_full", "groups", "more_groups"]),
  SignInSettings: strict({ password: bool, sso: bool, sso_allowed_domains: list(str),
    oauth_apps: { type: "boolean", description: "Members may connect apps to the MCP servers over OAuth (ADR 0010)" },
    oauth_scopes: { type: "array", items: { type: "string", enum: ["ops:read", "ops:write", "restricted:read", "admin"] }, description: "The scopes connected apps may be granted" } }),
  ConnectedApp: strict({
    id: { type: "string", description: "The grant (ogr_…): one approved connection of one member, one app and one MCP endpoint" },
    member: str,
    client: strict({ id: str, name: str, kind: { type: "string", enum: ["metadata_document", "registered"] }, verified_by_document: bool, redirect_host: str }),
    scopes: list(str), resource: { type: "string", description: "The MCP endpoint the app's tokens are for" },
    created_at: { type: "string", format: "date-time" }, last_used_at: nullable({ type: "string", format: "date-time" }), expires_at: { type: "string", format: "date-time" },
  }),
  Session: strict({
    id: str, method: str, signed_in_at: { type: "string", format: "date-time" }, last_seen_at: { type: "string", format: "date-time" },
    idle_expires_at: { type: "string", format: "date-time" }, expires_at: { type: "string", format: "date-time" },
    user_agent: nullable(str), client_address: nullable(str),
    current: { type: "boolean", description: "In your own list: true for the session making this request" },
  }, ["id", "method", "signed_in_at", "last_seen_at", "idle_expires_at", "expires_at", "user_agent", "client_address"]),
  SessionInfo: strict({
    session: strict({ id: str, method: str, signed_in_at: { type: "string", format: "date-time" }, expires_at: { type: "string", format: "date-time" },
      idle_expires_at: { type: "string", format: "date-time" } }),
    csrf_token: { type: "string", description: "Send as X-CSRF-Token on every request that changes something" },
    member: strict({ id: str, email: str, name: str,
      has_password: { type: "boolean", description: "The member has set a password (they can confirm it's them with it)" },
      sso_linked: { type: "boolean", description: "The member is linked to the single sign-on provider" } }),
    workspace: object({ id: str, name: str, sign_in: ref("SignInSettings") }),
    role: str, permissions: list(str),
    server: strict({
      connected_apps: { type: "boolean", description: "OAuth for MCP is turned on on this server (MCP_PUBLIC_URL), so members can connect apps; the workspace may still refuse it (sign_in.oauth_apps)" },
    }),
  }),
  Automation: object({
    id: str, name: str, description: nullable(str), enabled: bool,
    status: { type: "string", enum: ["enabled", "paused", "disabled", "archived"] },
    paused_at: nullable({ type: "string", format: "date-time" }), paused_reason: nullable(str), consecutive_failures: int,
    trigger: { type: "object", additionalProperties: true, description: "{type: event, event, changed_fields?, include_reference_moves?} | {type: schedule, …} | {type: manual, object?}" },
    condition: { description: "A filter in the query format, or null" },
    actions: { type: "array", items: anyObject, description: "The steps; secret header values are always null" },
    hourly_cap: int, run_roles: list(str), next_run_at: nullable({ type: "string", format: "date-time" }), version: int,
    created_at: { type: "string", format: "date-time" }, updated_at: { type: "string", format: "date-time" },
  }, ["id", "name", "enabled", "status", "trigger", "actions", "hourly_cap", "run_roles", "version"]),
  AutomationWrite: object({
    dry_run: bool, summary: str, warnings: list(str), next_runs: list(str),
    automation: { type: "object", additionalProperties: true, description: "The automation as saved (an Automation), or as it would be after a dry run" },
  }, ["dry_run", "summary", "warnings", "automation"]),
  AutomationRun: object({
    id: str, trigger: { type: "string", enum: ["event", "schedule", "manual"] }, event_id: nullable(str), record_id: nullable(str),
    scheduled_for: nullable(str), requested_by: nullable(str),
    requested_via: nullable({ type: "object", additionalProperties: true, description: "For a run requested by hand: the credential it was requested through (kind key, session or oauth, with its ID; for oauth the grant and client)" }),
    status: { type: "string", enum: ["queued", "running", "succeeded", "failed", "skipped"] }, reason: nullable(str),
    cap: nullable(str), failure: nullable({ type: "string", enum: ["data", "target", "config"] }), depth: int, attempts: int,
    usage: anyObject, results: { type: "array", items: anyObject }, started_at: str, finished_at: nullable(str),
  }, ["id", "trigger", "status", "reason", "results", "started_at"]),
  AutomationSettings: strict({ paused: bool, paused_at: nullable(str), paused_reason: nullable(str), external_email: bool, timezone: str }),
  SchedulePreview: strict({ summary: str, timezone: str, next_runs: list(str) }),
  Suppression: strict({ suppressed: bool, recipient: { type: "string", description: "A keyed hash of the mailbox, never the address" },
    since: nullable(str), reason: nullable(str), removed: bool }, ["suppressed", "recipient"]),
};

/** The responses map of one operation: the declared success, and problem documents for everything else. */
export function responsesFor(spec: ResponseSpec | undefined): Record<string, unknown> {
  const problem = { description: "An RFC 9457 problem document", content: { "application/problem+json": { schema: ref("Problem") } } };
  if (!spec) return { default: problem };
  const ok = { description: spec.description ?? "Success", content: { [spec.contentType ?? "application/json"]: { schema: spec.schema } } };
  return { [String(spec.status ?? 200)]: ok, ...(spec.alsoStatus ? { [String(spec.alsoStatus)]: { ...ok, description: "Success (a dry run)" } } : {}), default: problem };
}

/** Scalar shapes for route declarations. */
export const S = { str, int, bool, obj: anyObject, any: {} as JsonSchema, strs: list(str) };

/** A create that answers 201, or 200 for its dry run. */
export const createdOrDry = (s: JsonSchema = anyObject): ResponseSpec => ({ schema: s, status: 201, alsoStatus: 200 });

export const R = {
  record: data(ref("Record")),
  created: data(ref("Record"), 201),
  records: dataList(ref("Record")),
  page: plain(ref("RecordPage")),
  op: plain(ref("OpResult")),
  aggregate: plain(ref("Aggregate")),
  bulk: plain(ref("BulkResult")),
  merge: plain(ref("MergeResult")),
  duplicates: plain(ref("DuplicateGroups")),
  restored: plain(object({ data: ref("Record"), warnings: list(object({ field: str, message: str })) })),
  view: data(ref("View")),
  views: dataList(ref("View")),
  any: data(),
  anyData: data({}),
  anyList: dataList(),
  object: plain(anyObject),
  automation: data(ref("Automation")),
  automations: dataList(ref("Automation")),
  automationWrite: plain(ref("AutomationWrite")),
  automationRuns: dataList(ref("AutomationRun")),
  automationSettings: data(ref("AutomationSettings")),
  schedulePreview: data(ref("SchedulePreview")),
  suppression: data(ref("Suppression")),
};
