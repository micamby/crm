import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HEAVY_LIMITS, resetRateLimiter } from "../src/api/app.js";
import { routes } from "../src/api/registry.js";
import { decodeId } from "../src/lib/ids.js";
import { call, create, newWorkspace, signedIn, uniqueEmail, validate, type Schema, type Workspace } from "./helpers.js";

/**
 * People sign-in, the read side and the write side together.
 *
 * The rule for identity (core/context.ts `credential`): an API key is its own credential; a browser
 * session is the signed-in member, `user:<tenant>:<member>`, shared by all of that member's sessions.
 * The request budget, every cost charge, the heavy-request gate and confirm tokens all key on it. So a
 * confirm token minted in one of a member's sessions works in their other sessions, and is refused for
 * another member's session and for an API key, even one owned by the same member.
 */

const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 2, onnotice: () => {} });
afterAll(() => sql.end());

let ws: Workspace;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uuid = (id: string) => decodeId(id)!.uuid;

/** Adds a member with `role` and, with `scopes`, gives them an API key too. */
async function member(role = "member", scopes?: string[]) {
  const email = uniqueEmail(role);
  const m = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email, name: `C ${role}`, role } });
  if (m.status !== 201) throw new Error(`add member failed: ${m.status} ${JSON.stringify(m.json)}`);
  const id = m.json.data.id as string;
  if (!scopes) return { id, email, key: "" };
  const k = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: `${role} key`, scopes, owner: id } });
  if (k.status !== 201) throw new Error(`create key failed: ${k.status} ${JSON.stringify(k.json)}`);
  return { id, email, key: k.json.data.secret as string };
}

/** Holds a row lock on a contact for `ms` (as another writer would), so a bulk change of it stays in flight. */
async function holdContact(id: string, ms: number): Promise<{ released: Promise<void> }> {
  let taken!: () => void;
  const ready = new Promise<void>((r) => { taken = r; });
  const done = sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
    await tx`SELECT 1 FROM contacts WHERE id = ${uuid(id)} FOR UPDATE`;
    taken();
    await sleep(ms);
  }).then(() => undefined);
  await ready;
  return { released: done };
}

/** The declared success schema of one operation in the OpenAPI document. */
function declared(doc: Schema, template: string, method: string, status = 200): Schema {
  const op = (doc.paths as Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: Schema }> }> }>>)[template]![method]!;
  return op.responses[String(status)]!.content["application/json"]!.schema;
}

beforeAll(async () => {
  ws = await newWorkspace("Combined");
});

afterEach(() => {
  resetRateLimiter();
  HEAVY_LIMITS.perCredential = 2;
});

describe("write features from a browser session", () => {
  it("merges (dry run, token, run) and bulk-updates by filter end to end, with CSRF on every step", async () => {
    const m = await member();
    const b = await signedIn(m.email);
    const acct = await create(ws.keys.ops, "account", { name: `Merge Co ${Date.now()}` });
    const survivor = await create(ws.keys.ops, "contact", { first_name: "Sam", email: uniqueEmail("s"), account: acct.id });
    const dup = await create(ws.keys.ops, "contact", { first_name: "Sam", last_name: "Dup", email: uniqueEmail("d") });

    // The duplicate finder, then a merge's dry run: both POSTs, so both need the CSRF token.
    expect((await b.request("POST", "/v1/objects/contact/duplicates", { body: {}, csrf: false })).status).toBe(403);
    const dupes = await b.request("POST", "/v1/objects/contact/duplicates", { body: { rules: [["first_name"]] } });
    expect(dupes.status, JSON.stringify(dupes.json)).toBe(200);
    expect(dupes.json.groups.some((g: { records: { id: string }[] }) => g.records.some((r) => r.id === dup.id))).toBe(true);

    const body = { survivor: survivor.id, duplicates: [dup.id] };
    expect((await b.request("POST", "/v1/ops/merge_records", { body, csrf: false })).status).toBe(403);
    const dry = await b.request("POST", "/v1/ops/merge_records", { body });
    expect(dry.status, JSON.stringify(dry.json)).toBe(200);
    expect(dry.json).toMatchObject({ dry_run: true, merged: [dup.id] });
    const run = await b.request("POST", "/v1/ops/merge_records", { body: { ...body, dry_run: false, confirm_token: dry.json.confirm_token } });
    expect(run.status, JSON.stringify(run.json)).toBe(200);
    expect(run.json.survivor).toMatchObject({ id: survivor.id, last_name: "Dup" });
    // Single-use, for a session as for a key.
    const replay = await b.request("POST", "/v1/ops/merge_records", { body: { ...body, dry_run: false, confirm_token: dry.json.confirm_token } });
    expect(replay.status).toBe(409);

    // Bulk update by filter: dry run, then the run with its token, from the same session.
    const tag = `bulk${Date.now()}`;
    const targets = [await create(ws.keys.ops, "contact", { first_name: tag, email: uniqueEmail("b1") }),
      await create(ws.keys.ops, "contact", { first_name: tag, email: uniqueEmail("b2") })];
    const bulk = { where: { field: "first_name", op: "eq", value: tag }, values: { job_title: "Bulk" } };
    const preview = await b.request("POST", "/v1/objects/contact/records/bulk_update", { body: bulk });
    expect(preview.status, JSON.stringify(preview.json)).toBe(200);
    expect(preview.json).toMatchObject({ dry_run: true, count: 2 });
    expect((await b.request("POST", "/v1/objects/contact/records/bulk_update", { body: { ...bulk, dry_run: false, confirm_token: preview.json.confirm_token }, csrf: false })).status).toBe(403);
    const applied = await b.request("POST", "/v1/objects/contact/records/bulk_update", { body: { ...bulk, dry_run: false, confirm_token: preview.json.confirm_token } });
    expect(applied.status, JSON.stringify(applied.json)).toBe(200);
    expect(applied.json.counts.update).toBe(2);
    for (const t of targets) expect((await call("GET", `/v1/records/${t.id}`, { key: ws.keys.ops })).json.data.job_title).toBe("Bulk");

    // By IDs (no token needed at this size), a batch create's dry run, and a restore.
    const byIds = await b.request("POST", "/v1/objects/contact/records/bulk_archive", { body: { ids: [targets[0]!.id], dry_run: false } });
    expect(byIds.status, JSON.stringify(byIds.json)).toBe(200);
    const batch = await b.request("POST", "/v1/objects/contact/records/batch", { body: { dry_run: true, records: [{ email: uniqueEmail("x") }, { email: "bad" }] } });
    expect(batch.status, JSON.stringify(batch.json)).toBe(200);
    expect(batch.json.counts).toEqual({ create: 1, error: 1 });
    const restored = await b.request("POST", `/v1/objects/contact/records/${targets[0]!.id}/restore`, { body: {} });
    expect(restored.status, JSON.stringify(restored.json)).toBe(200);
    expect(restored.json.data.archived_at).toBeUndefined();
    // The merged duplicate can't be restored: its references belong to the survivor.
    const noRestore = await b.request("POST", `/v1/objects/contact/records/${dup.id}/restore`, { body: {} });
    expect(noRestore.status).toBe(409);

    // Every one of those responses matches what the OpenAPI document declares.
    const doc = (await b.request("GET", "/v1/openapi.json")).json as Schema;
    for (const [template, res, status] of [
      ["/v1/objects/{object}/duplicates", dupes, 200], ["/v1/ops/merge_records", dry, 200], ["/v1/ops/merge_records", run, 200],
      ["/v1/objects/{object}/records/bulk_update", preview, 200], ["/v1/objects/{object}/records/bulk_update", applied, 200],
      ["/v1/objects/{object}/records/bulk_archive", byIds, 200], ["/v1/objects/{object}/records/batch", batch, 200],
      ["/v1/objects/{object}/records/{id}/restore", restored, 200],
    ] as const) expect(validate(doc, declared(doc, template, "post", status), res.json), template).toEqual([]);
  });

  it("binds confirm tokens to the member: another session of theirs may run it; another member's session and an API key may not", async () => {
    const a = await member("member", ["ops:read", "ops:write"]);
    const other = await member("member");
    const [a1, a2, o1] = [await signedIn(a.email), await signedIn(a.email), await signedIn(other.email)];
    const tag = `tok${Date.now()}`;
    await create(ws.keys.ops, "contact", { first_name: tag, email: uniqueEmail("t") });
    const bulk = { where: { field: "first_name", op: "eq", value: tag }, values: { job_title: "Tokened" } };
    const mint = async () => {
      const dry = await a1.request("POST", "/v1/objects/contact/records/bulk_update", { body: bulk });
      expect(dry.status, JSON.stringify(dry.json)).toBe(200);
      return { ...bulk, dry_run: false, confirm_token: dry.json.confirm_token as string };
    };

    const run = await mint();
    // Another member, same role and permissions, same request: refused, and the token stays unspent.
    const theirs = await o1.request("POST", "/v1/objects/contact/records/bulk_update", { body: run });
    expect(theirs.status).toBe(400);
    expect(theirs.json.detail).toMatch(/issued for another/);
    // The same member's API key is a different credential.
    const viaKey = await call("POST", "/v1/objects/contact/records/bulk_update", { key: a.key, body: run });
    expect(viaKey.status).toBe(400);
    expect(viaKey.json.detail).toMatch(/issued for another/);
    // The member's other session runs it.
    const mine = await a2.request("POST", "/v1/objects/contact/records/bulk_update", { body: run });
    expect(mine.status, JSON.stringify(mine.json)).toBe(200);

    // A merge token the same way.
    const s = await create(ws.keys.ops, "contact", { first_name: "Keep", email: uniqueEmail("k") });
    const d = await create(ws.keys.ops, "contact", { first_name: "Drop", email: uniqueEmail("dr") });
    const body = { survivor: s.id, duplicates: [d.id] };
    const dry = await a2.request("POST", "/v1/ops/merge_records", { body });
    const real = { ...body, dry_run: false, confirm_token: dry.json.confirm_token };
    expect((await o1.request("POST", "/v1/ops/merge_records", { body: real })).status).toBe(400);
    expect((await call("POST", "/v1/ops/merge_records", { key: a.key, body: real })).status).toBe(400);
    expect((await a1.request("POST", "/v1/ops/merge_records", { body: real })).status).toBe(200);
  });
});

describe("one identity for the heavy-request gate and costs", () => {
  it("two sessions of one member share two heavy slots; another member's session doesn't", async () => {
    const m = await member();
    const other = await member();
    const [s1, s2, o1] = [await signedIn(m.email), await signedIn(m.email), await signedIn(other.email)];
    const c = await create(ws.keys.ops, "contact", { email: uniqueEmail("gate") });
    const { released } = await holdContact(c.id, 1_500);
    const heavy = (b: typeof s1) => b.request("POST", "/v1/objects/contact/records/bulk_archive", { body: { ids: [c.id] } });
    const running = [heavy(s1), heavy(s2)];
    await sleep(200);
    // A third heavy request from either of the member's sessions is refused at once.
    for (const b of [s1, s2]) {
      const third = await heavy(b);
      expect(third.status).toBe(429);
      expect(third.json.code).toBe("too_many_heavy_requests");
    }
    // Ordinary requests from the same member go through, and so does another member's heavy request.
    expect((await s1.request("GET", `/v1/records/${c.id}`)).status).toBe(200);
    const theirs = heavy(o1);
    await released;
    expect((await Promise.all(running)).map((r) => r.status)).toEqual([200, 200]);
    expect((await theirs).status).toBe(200);
  });

  it("charges every session of a member to one bucket, cost included", async () => {
    const m = await member();
    const [s1, s2] = [await signedIn(m.email), await signedIn(m.email)];
    // A merge's dry run of 10 duplicates costs 50 tokens: four, from either session, spend the burst of 200, and a fifth waits.
    const survivor = await create(ws.keys.ops, "contact", { email: uniqueEmail("sv") });
    const dups = await Promise.all(Array.from({ length: 10 }, (_, i) => create(ws.keys.ops, "contact", { email: uniqueEmail(`dp${i}`) })));
    const body = { survivor: survivor.id, duplicates: dups.map((d) => d.id) };
    resetRateLimiter();
    const statuses: number[] = [];
    for (const b of [s1, s2, s1, s2, s2]) statuses.push((await b.request("POST", "/v1/ops/merge_records", { body })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
    // Another member's session has its own bucket.
    const other = await signedIn((await member()).email);
    expect((await other.request("POST", "/v1/ops/merge_records", { body })).status).toBe(200);
  });

  it("gates aggregates, and lists and queries with a count, as heavy", async () => {
    const heavyRoute = (method: string, path: string) => routes.find((r) => r.method === method && r.path === path)!.heavy;
    expect(heavyRoute("POST", "/v1/aggregate")).toBe(true);
    for (const [method, path] of [["POST", "/v1/ops/merge_records"], ["POST", "/v1/objects/:object/duplicates"], ["POST", "/v1/objects/:object/records/bulk_update"],
      ["POST", "/v1/objects/:object/records/bulk_archive"], ["POST", "/v1/objects/:object/import"], ["GET", "/v1/objects/:object/export"],
      ["POST", "/v1/schema/plan"], ["POST", "/v1/schema/apply"]] as const) expect(heavyRoute(method, path), path).toBe(true);

    const m = await member("member", ["ops:read", "ops:write"]);
    const b = await signedIn(m.email);
    const c = await create(ws.keys.ops, "contact", { email: uniqueEmail("agg") });
    const { released } = await holdContact(c.id, 1_500);
    // The member's key and session are separate credentials: fill the session's two slots.
    const running = [0, 1].map(() => b.request("POST", "/v1/objects/contact/records/bulk_archive", { body: { ids: [c.id] } }));
    await sleep(200);
    const agg = await b.request("POST", "/v1/aggregate", { body: { object: "contact", group_by: [{ field: "lifecycle_stage" }] } });
    expect(agg.status).toBe(429);
    expect(agg.json.code).toBe("too_many_heavy_requests");
    expect((await b.request("GET", "/v1/objects/contact/records?count=true&limit=1")).status).toBe(429);
    expect((await b.request("POST", "/v1/query", { body: { object: "contact", count: true, limit: 1 } })).status).toBe(429);
    // Without a count a list isn't heavy, and the member's key has its own slots.
    expect((await b.request("GET", "/v1/objects/contact/records?limit=1")).status).toBe(200);
    expect((await call("POST", "/v1/aggregate", { key: m.key, body: { object: "contact" } })).status).toBe(200);
    await released;
    expect((await Promise.all(running)).map((r) => r.status)).toEqual([200, 200]);
    expect((await b.request("POST", "/v1/aggregate", { body: { object: "contact" } })).status).toBe(200);
  });
});

describe("merged records through the read side", () => {
  it("keep merged_into and merge_chain under fields=, include=, archived_only, a view, multi-sort and a count, as the document declares", async () => {
    const acct = await create(ws.keys.ops, "account", { name: `Merged Co ${Date.now()}` });
    const last = `Merged${Date.now()}`;
    const survivor = await create(ws.keys.ops, "contact", { first_name: "Ann", last_name: last, email: uniqueEmail("ms"), account: acct.id });
    const dup = await create(ws.keys.ops, "contact", { first_name: "Anne", last_name: last, email: uniqueEmail("md"), account: acct.id });
    const dry = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { survivor: survivor.id, duplicates: [dup.id] } });
    expect((await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops,
      body: { survivor: survivor.id, duplicates: [dup.id], dry_run: false, confirm_token: dry.json.confirm_token } })).status).toBe(200);
    const doc = (await call("GET", "/v1/openapi.json", { key: ws.keys.ops })).json as Schema;

    // One record, with a projection that leaves the merge fields out, and an include.
    const one = await call("GET", `/v1/records/${dup.id}?fields=first_name&include=account`, { key: ws.keys.ops });
    expect(one.status, JSON.stringify(one.json)).toBe(200);
    expect(one.json.data).toMatchObject({ id: dup.id, first_name: "Anne", merged_into: survivor.id, merge_chain: [survivor.id], included: { account: { id: acct.id } } });
    expect(one.json.data.email).toBeUndefined();
    expect(validate(doc, declared(doc, "/v1/records/{id}", "get"), one.json)).toEqual([]);
    // Asked for by name, too.
    const named = await call("GET", `/v1/objects/contact/records/${dup.id}?fields=merged_into,merge_chain`, { key: ws.keys.ops });
    expect(named.status, JSON.stringify(named.json)).toBe(200);
    expect(named.json.data.merged_into).toBe(survivor.id);

    // A saved view, then archived_only with multi-sort, a count, fields and include on the list and query routes.
    const view = await call("POST", "/v1/views", { key: ws.keys.ops, body: { object: "contact", name: "By name", where: { field: "last_name", op: "eq", value: last },
      sort: [{ field: "first_name" }], columns: ["first_name", "account"] } });
    expect(view.status, JSON.stringify(view.json)).toBe(201);
    const v = view.json.data.id as string;
    expect(v).toMatch(/^v_/);
    const list = await call("GET", `/v1/objects/contact/records?view=${v}&archived_only=true&count=true&include=account&sort=first_name,-created_at`, { key: ws.keys.ops });
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect(list.json.total).toBe(1);
    expect(list.json.data).toHaveLength(1);
    expect(list.json.data[0]).toMatchObject({ id: dup.id, merged_into: survivor.id, included: { account: { id: acct.id } } });
    expect(list.json.data[0].email).toBeUndefined(); // the view's columns
    expect(validate(doc, declared(doc, "/v1/objects/{object}/records", "get"), list.json)).toEqual([]);
    const live = await call("GET", `/v1/objects/contact/records?view=${v}&count=true`, { key: ws.keys.ops });
    expect(live.json.data.map((r: { id: string }) => r.id)).toEqual([survivor.id]);
    expect(live.json.data[0].merged_into).toBeUndefined();

    const q = await call("POST", "/v1/query", { key: ws.keys.ops, body: { view: v, archived_only: true, count: true, fields: ["first_name"], include: ["account.name"],
      sort: [{ field: "first_name" }, { field: "created_at", dir: "desc" }] } });
    expect(q.status, JSON.stringify(q.json)).toBe(200);
    expect(q.json).toMatchObject({ total: 1, data: [{ id: dup.id, merged_into: survivor.id, merge_chain: [survivor.id], included: { account: { name: acct.name } } }] });
    expect(validate(doc, declared(doc, "/v1/query", "post"), q.json)).toEqual([]);

    // The per-object record schema declares the merge properties.
    const contactRecord = (doc.components as { schemas: Record<string, { properties: Record<string, unknown> }> }).schemas.contact_record!;
    expect(Object.keys(contactRecord.properties)).toEqual(expect.arrayContaining(["merged_into", "merge_chain", "included"]));
  });

  it("reserves merged_into and merge_chain as field names", async () => {
    for (const api_name of ["merged_into", "merge_chain"]) {
      const res = await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name, type: "text" } });
      expect(res.status).toBe(422);
    }
  });
});
