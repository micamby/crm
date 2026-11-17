import { z } from "zod";
import { BULK_CAP, BULK_IDS_WITHOUT_TOKEN, bulkChange, PREVIEW_PER_TOKEN, tokenSize } from "../core/bulk.js";
import { findDuplicates } from "../core/duplicates.js";
import { MERGE_MAX_DUPLICATES, MERGE_MAX_REFERENCES, mergeRecords } from "../core/merge.js";
import type { Where } from "../core/query.js";
import { restoreRecord } from "../core/records.js";
import { route } from "./registry.js";
import { R } from "./responses.js";

// --- Write-side record work: restore, duplicates, merge, bulk changes ------------------------

/**
 * Rate-limit tokens per record. A dry run does every record's real work and rolls it back, so it costs
 * one token per PREVIEW_PER_TOKEN (10) records; by filter the count is known only afterwards, so it takes
 * one token up front and the rest once it has run. A real bulk change emits an event per record, so it is
 * charged closer to the single updates it replaces: 3 records per token, so 500 records take 167 of a full
 * bucket's 200 (see docs/permissions.md). Every one of these routes is also `heavy`: at most two at once per credential (a key, or a signed-in member).
 */
const RUN_PER_TOKEN = 3;

const BulkBody = {
  ids: z.array(z.string()).max(BULK_CAP).optional().describe(`Record IDs (1 to ${BULK_CAP})`),
  where: z.unknown().optional().describe("A filter, as in POST /v1/query. A real run needs the confirm_token of a dry run with the same filter"),
  expected_versions: z.record(z.string(), z.number().int()).optional().describe("Per record ID, the version you read; a record that has changed since fails"),
  dry_run: z.boolean().optional().describe("Defaults to true: report what each record would do, change nothing"),
  confirm_token: z.string().max(20_000).optional().describe(`From the dry run of the same request: required by filter, and by ids above ${BULK_IDS_WITHOUT_TOKEN} records. Single-use`),
};
type BulkBodyT = { ids?: string[]; where?: unknown; dry_run?: boolean; confirm_token?: string };
const bulkCost = (b: BulkBodyT) => {
  const preview = b.dry_run ?? true;
  if (preview && !b.ids) return 1; // the rest once the filter's count is known
  const n = b.ids ? b.ids.length : tokenSize(b.confirm_token);
  return Math.ceil(n / (preview ? PREVIEW_PER_TOKEN : RUN_PER_TOKEN));
};
/** A filter's dry run pays for the records it examined, after the fact (one token was taken up front). */
const chargePreview = (b: BulkBodyT, count: number, charge: (n: number) => void) => {
  if ((b.dry_run ?? true) && !b.ids) charge(Math.ceil(count / PREVIEW_PER_TOKEN) - 1);
};

route({
  method: "POST", path: "/v1/objects/:object/records/:id/restore", scope: "ops:write", permission: "records:archive", tag: "records",
  summary: "Restore (un-archive) a record. Refused when a unique value is now held by another record, or when the record was merged",
  idParams: { id: "record" },
  response: R.restored,
  handler: async ({ tx, ctx, params }) => ({ body: await restoreRecord(tx, ctx, params.object!, params.id!) }),
});

route({
  method: "POST", path: "/v1/objects/:object/duplicates", scope: "ops:read", tag: "records",
  summary: "Find groups of likely duplicates, each with the reason: normalized email, domain or name (contacts, accounts, leads), "
    + "or the fields you name; fuzzy: true adds similar names. Examines the newest 10,000 records. Changes nothing",
  cost: (b) => (b.fuzzy ? 10 : 5),
  heavy: true,
  response: R.duplicates,
  body: z.object({
    rules: z.array(z.array(z.string()).min(1).max(4)).min(1).max(5).optional().describe('Field lists to match on, e.g. [["email"], ["first_name", "last_name", "account"]]'),
    fuzzy: z.boolean().optional(), min_similarity: z.number().min(0.3).max(1).optional(), limit: z.number().int().min(1).max(200).optional(),
  }).strict(),
  handler: async ({ tx, ctx, params, body }) => ({ body: await findDuplicates(tx, ctx, params.object!, body) }),
});

route({
  method: "POST", path: "/v1/ops/merge_records", scope: "ops:write", tag: "operations",
  summary: `Merge up to ${MERGE_MAX_DUPLICATES} duplicates into a survivor (contacts, accounts, leads, custom objects). dry_run defaults to true and returns a `
    + "confirm_token; a real run needs it, and applies only if the request and the records are as previewed. The survivor keeps its values and fills blanks from "
    + `the duplicates unless fields chooses; every reference moves to it (at most ${MERGE_MAX_REFERENCES} per merge); the duplicates are archived and point to it`,
  // Statements grow with the duplicates (every referencing table, for each), and a dry run does the same work.
  cost: (b) => 5 * b.duplicates.length,
  heavy: true,
  response: R.merge,
  body: z.object({
    survivor: z.string(), duplicates: z.array(z.string()).min(1).max(MERGE_MAX_DUPLICATES),
    fields: z.record(z.string(), z.string()).optional().describe("Per field, the ID of the record (survivor or duplicate) whose value to keep"),
    expected_version: z.number().int().optional(), dry_run: z.boolean().optional(),
    confirm_token: z.string().max(2_000).optional().describe("From the dry run of the same merge; required to apply it. Single-use"),
  }).strict(),
  handler: async ({ tx, ctx, body }) => {
    const { dry_run, ...input } = body;
    return { body: await mergeRecords(tx, ctx, input, dry_run ?? true) };
  },
});

route({
  method: "POST", path: "/v1/objects/:object/records/bulk_update", scope: "ops:write", tag: "records",
  summary: `Set the same values on up to ${BULK_CAP} records, by ids or by a filter (dry run first, then its single-use confirm_token; by ids, needed above `
    + `${BULK_IDS_WITHOUT_TOKEN} records). dry_run defaults to true; a real run is all or nothing, and each record goes through the normal update`,
  cost: bulkCost,
  heavy: true,
  response: R.bulk,
  body: z.object({ ...BulkBody, values: z.record(z.string(), z.unknown()) }).strict(),
  handler: async ({ tx, ctx, params, body, charge }) => {
    const out = await bulkChange(tx, ctx, params.object!, "update", { ...body, where: body.where as Where | undefined });
    chargePreview(body, out.count, charge);
    return { body: out };
  },
});

route({
  method: "POST", path: "/v1/objects/:object/records/bulk_archive", scope: "ops:write", permission: "records:archive", tag: "records",
  summary: `Archive up to ${BULK_CAP} records, by ids or by a filter (dry run first, then its single-use confirm_token; by ids, needed above `
    + `${BULK_IDS_WITHOUT_TOKEN} records). dry_run defaults to true; a real run is all or nothing`,
  cost: bulkCost,
  heavy: true,
  response: R.bulk,
  body: z.object(BulkBody).strict(),
  handler: async ({ tx, ctx, params, body, charge }) => {
    const out = await bulkChange(tx, ctx, params.object!, "archive", { ...body, where: body.where as Where | undefined });
    chargePreview(body, out.count, charge);
    return { body: out };
  },
});
