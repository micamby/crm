import { z } from "zod";
import { AGGREGATE_LIMITS } from "../core/aggregate.js";
import { getPreferences, listUsers, setPreferences } from "../core/directory.js";
import type { Where } from "../core/query.js";
import { aggregateRecords } from "../core/reads.js";
import { createView, deleteView, getView, listViews, updateView, type ViewInput } from "../core/views.js";
import { ApiError, unprocessable } from "../lib/errors.js";
import { route } from "./registry.js";
import { data, list, nullable, object, plain, R, ref, S } from "./responses.js";
import { parseIfMatch } from "./routes.js";

// --- Aggregates, saved views, the member directory and preferences (read-side features for UIs) --

/**
 * A backstop for routes that store or look up what the caller sent: the code checks values first, so a
 * database CHECK or cast refusal (SQLSTATE class 22, or 23514) reaching here is still the caller's input,
 * and a 422 rather than a 500. Only these routes: elsewhere such an error may be a bug and stays a 500.
 */
async function userInput<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (!(e instanceof ApiError) && typeof code === "string" && (code.startsWith("22") || code === "23514")) {
      throw unprocessable("A value in the request is not valid (too large or malformed)");
    }
    throw e;
  }
}

const GroupBy = z.array(z.object({ field: z.string(), bucket: z.enum(["day", "week", "month", "quarter", "year"]).optional() }))
  .max(AGGREGATE_LIMITS.maxGroupBy);
const Sort = z.array(z.object({ field: z.string(), dir: z.enum(["asc", "desc"]).optional() })).max(3);

route({
  method: "POST", path: "/v1/aggregate", scope: "ops:read", tag: "records",
  summary: `Count and total records per group: up to ${AGGREGATE_LIMITS.maxGroupBy} group_by fields (select, status, boolean, text, many-to-one relation, `
    + `or a date bucketed by day, week, month, quarter or year) and measures (count, and sum, avg, min, max on number and currency fields). `
    + `Same filter and access rules as a query; at most ${AGGREGATE_LIMITS.maxGroups} groups, from at most the 100,000 most recently updated matching records (rows_capped says when more matched)`,
  body: z.object({
    object: z.string().optional().describe("Required unless view is given"),
    where: z.unknown().optional(),
    group_by: GroupBy.optional(),
    measures: z.array(z.object({ op: z.enum(["count", "sum", "avg", "min", "max"]), field: z.string().optional() })).max(AGGREGATE_LIMITS.maxMeasures).optional(),
    limit: z.number().int().positive().max(AGGREGATE_LIMITS.maxGroups).optional(),
    order: z.enum(["key", "count"]).optional(),
    include_archived: z.boolean().optional(),
    view: z.string().optional().describe("Use a saved view's filter and group_by; fields given here override the view's"),
  }).strict(),
  response: R.aggregate,
  // Scans up to 100,000 records in one statement: gated with the write side's long-running work (api/app.ts).
  heavy: true,
  // One statement over up to AGGREGATE_ROWS.max records; each grouping and measure adds to its work.
  // A view's grouping is not known yet, so naming a view counts as the most it could add.
  cost: (b) => 2 + (b.group_by?.length ?? (b.view !== undefined ? AGGREGATE_LIMITS.maxGroupBy : 0)) + (b.measures?.length ?? 0),
  handler: async ({ tx, ctx, body }) => {
    if (!body.object && body.view === undefined) throw unprocessable("object is required (or a view)");
    return { body: await aggregateRecords(tx, ctx, { ...body, object: body.object ?? "", where: body.where as Where | undefined }) };
  },
});

const ViewBody = {
  name: z.string().max(100),
  where: z.unknown().optional(),
  sort: Sort.optional(),
  columns: z.array(z.string()).max(100).optional(),
  group_by: GroupBy.optional(),
  shared: z.boolean().optional().describe("Shared with the workspace (needs views:manage); otherwise personal"),
};

route({
  method: "GET", path: "/v1/views", scope: "ops:read", tag: "views",
  summary: "Saved views this key can see: its member's personal views and every shared view, on objects it can read",
  query: z.object({ object: z.string().optional() }), response: R.views,
  handler: async ({ tx, ctx, query }) => ({ body: { data: await listViews(tx, ctx, query.object) } }),
});

route({
  method: "GET", path: "/v1/objects/:object/views", scope: "ops:read", tag: "views", summary: "Saved views of one object",
  response: R.views,
  handler: async ({ tx, ctx, params }) => ({ body: { data: await listViews(tx, ctx, params.object!) } }),
});

route({
  method: "POST", path: "/v1/views", scope: "ops:read", tag: "views",
  summary: "Save a view: a filter, sort, columns and optional grouping on one object. Personal by default; shared: true needs views:manage. "
    + "A view runs with each reader's own access",
  body: z.object({ object: z.string(), ...ViewBody }).strict(), response: data(ref("View"), 201),
  handler: async ({ tx, ctx, body }) => ({ status: 201, body: { data: await userInput(() => createView(tx, ctx, body as ViewInput)) } }),
});

route({
  method: "GET", path: "/v1/views/:id", scope: "ops:read", tag: "views", summary: "Get a saved view", idParams: { id: "view" },
  response: R.view,
  handler: async ({ tx, ctx, params }) => ({ body: { data: await getView(tx, ctx, params.id!) } }),
});

route({
  method: "PATCH", path: "/v1/views/:id", scope: "ops:read", tag: "views", idParams: { id: "view" },
  summary: "Change a saved view (its owner, or views:manage for a shared one). null clears where, sort, columns or group_by. Send If-Match with the version you read",
  body: z.object({
    name: ViewBody.name.optional(), where: z.unknown().optional(), sort: Sort.nullable().optional(), columns: ViewBody.columns.nullable(),
    group_by: GroupBy.nullable().optional(), shared: z.boolean().optional(),
  }).strict(),
  response: R.view,
  handler: async ({ tx, ctx, params, body, headers }) => ({
    body: { data: await userInput(() => updateView(tx, ctx, params.id!, body as ViewInput, parseIfMatch(headers.get("if-match")))) },
  }),
});

route({
  method: "DELETE", path: "/v1/views/:id", scope: "ops:read", tag: "views", summary: "Delete a saved view (its owner, or views:manage for a shared one)",
  idParams: { id: "view" }, response: data(object({ id: S.str, deleted: S.bool })),
  handler: async ({ tx, ctx, params }) => ({ body: { data: await deleteView(tx, ctx, params.id!) } }),
});

route({
  method: "GET", path: "/v1/users", scope: "ops:read", tag: "workspace",
  summary: "Active users for owner and assignee pickers: id, name and email. Needs read access to a field that refers to users (such as owner)",
  query: z.object({ q: z.string().optional(), limit: z.coerce.number().int().optional(), cursor: z.string().max(2_000).optional() }),
  response: plain(object({ data: list(ref("DirectoryUser")), next_cursor: nullable(S.str) })),
  handler: async ({ tx, ctx, query }) => ({ body: await userInput(() => listUsers(tx, ctx, query)) }),
});

route({
  method: "GET", path: "/v1/me/preferences", scope: "any", tag: "workspace", summary: "My preferences: UI state such as column widths or the last view opened",
  response: data({ type: "object", additionalProperties: true }),
  handler: async ({ tx, ctx }) => ({ body: { data: await getPreferences(tx, ctx) } }),
});

route({
  method: "PUT", path: "/v1/me/preferences", scope: "any", tag: "workspace",
  summary: "Set my preferences: the keys given are set (null removes one), others are kept. At most 100 keys, 8 KB each. Not for secrets",
  body: z.record(z.string(), z.unknown()), response: data({ type: "object", additionalProperties: true }),
  handler: async ({ tx, ctx, body }) => ({ body: { data: await userInput(() => setPreferences(tx, ctx, body)) } }),
});

