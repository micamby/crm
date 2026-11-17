import { z } from "zod";
import { EXPORT_ROW_CAP, exportRecords, IMPORT_ROW_CAP, importRecords } from "../core/transfer.js";
import { loadSchema } from "../core/schema.js";
import { resolveView } from "../core/views.js";
import { unprocessable } from "../lib/errors.js";
import { route } from "./registry.js";
import { R } from "./responses.js";
import { filtersFromQuery, sortFromQuery } from "./routes.js";

// --- Bulk export and import (see core/transfer.ts) -------------------------------------------

/** Rows an import may send per rate-limit token: the batch route's 100 records per request. */
const IMPORT_ROWS_PER_TOKEN = 100;

route({
  method: "GET", path: "/v1/objects/:object/export", scope: "ops:read", tag: "records",
  summary: `Export records as CSV (format=csv, the default) or NDJSON (format=ndjson). Same filters, sort and redaction as the list route. `
    + `At most ${EXPORT_ROW_CAP} rows per response; when there are more, X-Next-Cursor holds the cursor for the next request. view=v_… uses a saved view's filter and sort`,
  response: { schema: { type: "string" }, contentType: "text/csv", description: "CSV, or NDJSON (application/x-ndjson) with format=ndjson" },
  heavy: true,
  handler: async ({ tx, ctx, params, query }) => {
    const format = query.format ?? "csv";
    if (format !== "csv" && format !== "ndjson") throw unprocessable("format must be csv or ndjson");
    const limit = query.limit ? Number(query.limit) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw unprocessable("limit must be a positive integer");
    const view = query.view === undefined ? undefined : await resolveView(tx, ctx, await loadSchema(tx), query.view, params.object!);
    const out = await exportRecords(tx, ctx, {
      object: params.object!, where: filtersFromQuery(query) ?? view?.where, format, limit, cursor: query.cursor,
      sort: sortFromQuery(query.sort, query.dir) ?? view?.sort,
      includeArchived: query.include_archived === "true", includeHidden: query.include_hidden === "true",
    });
    return {
      body: out.body,
      headers: {
        "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="${params.object!.replace(/[^a-z0-9_]/g, "")}.${format}"`,
        "X-Row-Count": String(out.rows),
        ...(out.nextCursor ? { "X-Next-Cursor": out.nextCursor } : {}),
      },
    };
  },
});

route({
  method: "POST", path: "/v1/objects/:object/import", scope: "ops:write", tag: "records",
  response: R.object,
  summary: `Import up to ${IMPORT_ROW_CAP} CSV rows: create, or update by an upsert key (id or a unique field). dry_run defaults to true and reports `
    + `what each row would do; a real run is all or nothing. Counts as one request per ${IMPORT_ROWS_PER_TOKEN} rows against the key's rate limit, dry runs too`,
  // Each row costs what a record in the batch route does, so an import is rate limited like the batch requests it replaces.
  cost: (b) => Math.ceil(((b.csv.match(/\n/g)?.length ?? 0) + 1) / IMPORT_ROWS_PER_TOKEN),
  heavy: true,
  body: z.object({
    csv: z.string().max(1_000_000),
    mapping: z.record(z.string(), z.string()).optional(),
    key: z.string().optional(),
    dry_run: z.boolean().optional(),
    unescape_formulas: z.boolean().optional(),
  }).strict(),
  handler: async ({ tx, ctx, params, body }) => ({ body: await importRecords(tx, ctx, params.object!, body) }),
});
