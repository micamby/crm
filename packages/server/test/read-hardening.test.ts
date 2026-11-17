import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGGREGATE_ROWS } from "../src/core/aggregate.js";
import { routes } from "../src/api/registry.js";
import { MAX_CURSOR } from "../src/core/query.js";
import { loadSchema } from "../src/core/schema.js";
import { withTenant } from "../src/db/tx.js";
import { decodeId } from "../src/lib/ids.js";
import { call, create, memberWithKey, newWorkspace, uniqueEmail, type Workspace } from "./helpers.js";

/**
 * Hardening of the read-side features: a saved view's definition never reaches someone who can't read what
 * it uses (whoever wrote it), user input that the database would refuse is a 4xx, pagination survives any
 * value a writer can store, aggregates are bounded, and the odds and ends around views, includes and scopes.
 */

const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
afterAll(() => sql.end());

const SECRET = `zq${Date.now().toString(36)}hardsentinel`;
const has = (body: unknown, s: string) => JSON.stringify(body ?? null).includes(s);
const inTenant = <T>(tenant: string, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
  sql.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenant}, true)`;
    return fn(tx);
  }) as Promise<T>;
/** Bumps the schema version, as a schema change would, so every process reloads the metadata changed in SQL. */
const bumpSchema = (tx: postgres.TransactionSql) => tx`UPDATE tenants SET schema_version = schema_version + 1`;
const ALL = ["records:read", "records:write", "records:archive"];
const OPS = ["ops:read", "ops:write"];
let n = 0;
const slug = (s: string) => `${s}_${++n}_${Date.now().toString(36)}`;

let ws: Workspace;
let contactId: string;
beforeAll(async () => {
  ws = await newWorkspace("Hardening");
  expect((await call("POST", "/v1/objects/deal/fields", { key: ws.keys.admin, body: { api_name: "deal_secret", type: "text" } })).status).toBe(201);
  contactId = (await create(ws.keys.ops, "contact", { email: uniqueEmail("h") })).id;
  for (const name of ["One", "Two", "Three"]) await create(ws.keys.ops, "deal", { name, amount: 10, primary_contact: contactId, deal_secret: SECRET });
});

async function role(w: Workspace, permissions: string[], rules: Record<string, unknown> = {}) {
  const r = await call("POST", "/v1/roles", { key: w.keys.admin, body: { key: slug("r"), name: "Custom", permissions, ...rules } });
  if (r.status !== 201) throw new Error(`role failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data as { id: string; key: string };
}

describe("a saved view's definition", () => {
  it("is not shown to its author once someone else changes it to use what the author can't read", async () => {
    const curatorRole = await role(ws, ["records:read", "views:manage"], { fields: { deal: { deal_secret: "none" } } });
    const curator = await memberWithKey(ws, curatorRole.key, ["ops:write"]);
    const made = await call("POST", "/v1/views", { key: curator.key, body: { object: "deal", name: "Curated", shared: true, where: { field: "name", op: "eq", value: "One" } } });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const id = made.json.data.id as string;
    const edited = await call("PATCH", `/v1/views/${id}`, { key: ws.keys.ops, body: { where: { field: "deal_secret", op: "eq", value: SECRET } } });
    expect(edited.status).toBe(200);
    expect(edited.json.data.where.value).toBe(SECRET); // the editor can read it

    const one = await call("GET", `/v1/views/${id}`, { key: curator.key });
    expect(one.status).toBe(200);
    expect(one.json.data).toMatchObject({ status: "unavailable" });
    expect("where" in one.json.data).toBe(false);
    for (const path of [`/v1/views/${id}`, "/v1/views", "/v1/objects/deal/views", `/v1/objects/deal/records?view=${id}`, `/v1/objects/deal/export?view=${id}`]) {
      const r = await call("GET", path, { key: curator.key });
      expect(has(r.json, SECRET), path).toBe(false);
    }
    for (const [path, body] of [["/v1/query", { view: id }], ["/v1/aggregate", { view: id }]] as const) {
      const r = await call("POST", path, { key: curator.key, body });
      expect(r.status).toBe(403);
      expect(has(r.json, SECRET)).toBe(false);
    }
    // The author can't change it back blind either: their change is checked with their access.
    expect((await call("PATCH", `/v1/views/${id}`, { key: curator.key, body: { name: "Renamed" } })).status).toBe(403);
    // The audit trail keeps who wrote it and who changed it, and its entries name the view, never its filter.
    const [row] = await inTenant(ws.tenantId, (tx) => tx<{ created_by: string; updated_by: string }[]>`SELECT created_by, updated_by FROM views WHERE id = ${decodeId(id)!.uuid}`);
    expect(row!.created_by).toBe(decodeId(curator.id)!.uuid);
    expect(row!.updated_by).toBe(decodeId(ws.ownerId)!.uuid);
    const log = await call("GET", "/v1/audit-log?action=view.", { key: ws.keys.admin });
    expect(log.status).toBe(200);
    expect(log.json.data.length).toBeGreaterThan(0);
    expect(has(log.json, SECRET)).toBe(false);
  });

  it("of a broken view names the missing fields only to a caller who can read everything else it uses, and never quotes its values", async () => {
    expect((await call("POST", "/v1/objects/deal/fields", { key: ws.keys.admin, body: { api_name: "region", type: "text" } })).status).toBe(201);
    const v = await call("POST", "/v1/views", { key: ws.keys.ops, body: { object: "deal", name: "By region", shared: true,
      where: { field: "region", op: "eq", value: SECRET }, sort: [{ field: "deal_secret" }] } });
    expect(v.status).toBe(201);
    expect((await call("PATCH", "/v1/objects/deal/fields/region", { key: ws.keys.admin, body: { api_name: "zone" } })).status).toBe(200);
    const owner = await call("GET", `/v1/views/${v.json.data.id}`, { key: ws.keys.ops });
    expect(owner.json.data.status).toBe("broken");
    expect(owner.json.data.problem).toMatch(/"region"/);
    expect(has(owner.json, SECRET)).toBe(false);
    const blindRole = await role(ws, ALL, { fields: { deal: { deal_secret: "none" } } });
    const blind = await memberWithKey(ws, blindRole.key, OPS);
    const theirs = await call("GET", `/v1/views/${v.json.data.id}`, { key: blind.key });
    expect(theirs.json.data.status).toBe("broken");
    expect(theirs.json.data.problem).not.toMatch(/region|deal_secret/);
    const run = await call("POST", "/v1/query", { key: ws.keys.ops, body: { view: v.json.data.id } });
    expect(run.json.code).toBe("view_invalid");
    expect(has(run.json, SECRET)).toBe(false);
  });

  it("of a view on an object whose module is off is hidden from a role that can't read that object", async () => {
    const w = await newWorkspace("Hidden module");
    const r = await role(w, ALL, { objects: { deal: { read: false, write: false, archive: false } } });
    const m = await memberWithKey(w, r.key, OPS);
    const v = await call("POST", "/v1/views", { key: w.keys.ops, body: { object: "deal", name: "Quarter-end pushes", shared: true } });
    expect(v.status).toBe(201);
    expect((await call("PATCH", "/v1/workspace/modules", { key: w.keys.admin, body: { modules: ["core"] } })).status).toBe(200);
    const listed = await call("GET", "/v1/views", { key: m.key });
    expect(listed.status).toBe(200);
    expect(has(listed.json, "Quarter-end pushes")).toBe(false);
    expect((await call("GET", `/v1/views/${v.json.data.id}`, { key: m.key })).status).toBe(404);
    // The owner can still see it is broken, and delete it.
    expect((await call("GET", `/v1/views/${v.json.data.id}`, { key: w.keys.ops })).json.data.status).toBe("broken");
  });
});

describe("input the database would refuse", () => {
  it("is a 422, not a 500: an oversized view definition, preference or a malformed directory cursor", async () => {
    // Over 32 KB as the database measures it.
    const big = { field: "name", op: "in", value: Array.from({ length: 500 }, (_, i) => `${i}`.padEnd(70, "x")) };
    const created = await call("POST", "/v1/views", { key: ws.keys.ops, body: { object: "deal", name: "Big", where: big } });
    expect(created.status, JSON.stringify(created.json)).toBe(422);
    expect(created.json.detail).toMatch(/32768 bytes/);
    const small = await call("POST", "/v1/views", { key: ws.keys.ops, body: { object: "deal", name: "Small" } });
    expect((await call("PATCH", `/v1/views/${small.json.data.id}`, { key: ws.keys.ops, body: { where: big } })).status).toBe(422);
    // Under 8 KB as JSON.stringify writes it ("1,1,…"), over it as jsonb text ("1, 1, …"), which the CHECK measures.
    const pref = Array.from({ length: 3_000 }, () => 1);
    expect(JSON.stringify(pref).length).toBeLessThan(8_192);
    const p = await call("PUT", "/v1/me/preferences", { key: ws.keys.ops, body: { "grid.widths": pref } });
    expect(p.status, JSON.stringify(p.json)).toBe(422);
    expect(p.json.detail).toMatch(/8192 bytes/);
    const cursor = Buffer.from(JSON.stringify({ n: "a", id: "-".repeat(36) })).toString("base64url");
    expect((await call("GET", `/v1/users?cursor=${cursor}`, { key: ws.keys.ops })).status).toBe(422);
  });

  it("is a 422 when Postgres itself refuses a value on these routes (a lone surrogate jsonb can't hold)", async () => {
    expect((await call("PUT", "/v1/me/preferences", { key: ws.keys.ops, body: { "ui.label": "\ud800" } })).status).toBe(422);
    expect((await call("POST", "/v1/views", { key: ws.keys.ops, body: { object: "deal", name: "Odd", where: { field: "name", op: "eq", value: "\ud800" } } })).status).toBe(422);
  });
});

describe("pagination over extreme values", () => {
  let w: Workspace;
  const ids: string[] = [];
  beforeAll(async () => {
    w = await newWorkspace("Extremes");
    const def = { api_name: "sample", label: "Sample", plural_label: "Samples", fields: [
      { api_name: "t", type: "text" }, { api_name: "notes", type: "long_text" }, { api_name: "n", type: "number" },
      { api_name: "d", type: "date" }, { api_name: "dt", type: "datetime" }, { api_name: "code", type: "text" },
    ] };
    const made = await call("POST", "/v1/objects", { key: w.keys.admin, body: def });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const tie = "語".repeat(200);
    const values: Record<string, unknown>[] = [
      { t: "語".repeat(2_000), n: 1e15, d: "0001-01-01", dt: "9999-12-31T23:59:59.999Z", code: "02139" },
      { t: "😀".repeat(1_000), n: -1e15, d: "9999-12-31", dt: "0001-01-01T00:00:00.000Z" },
      { t: "\u0001".repeat(2_000), n: 1.234567890123456e-15, d: null, dt: null, notes: "x".repeat(100_000) },
      { t: `${tie}a`, n: 0, d: "2024-02-29", dt: "2024-02-29T12:00:00.123Z" },
      { t: `${tie}b`, n: null, d: "2024-02-29", dt: "2024-02-29T12:00:00.123Z" },
      { t: `${tie}a`, n: 0 }, { t: "a".repeat(2_000) }, { t: null }, { t: "" }, { code: "2139" },
      { t: "legacy number" }, { t: "legacy tiny" }, { t: "legacy subnormal" }, { t: "legacy most negative" }, { t: "legacy year zero" },
    ];
    for (const v of values) ids.push((await create(w.keys.ops, "sample", v)).id);
    // Values stored before numbers and dates were bounded at write time: put in directly.
    await inTenant(w.tenantId, async (tx) => {
      const keys = Object.fromEntries((await tx<{ api_name: string; storage_key: string }[]>`
        SELECT f.api_name, f.storage_key FROM fields f JOIN objects o ON o.id = f.object_id WHERE o.api_name = 'sample'`).map((r) => [r.api_name, r.storage_key]));
      const set = (i: number, field: string, json: string) => tx`UPDATE records SET data = jsonb_set(data, ${[keys[field]!]}::text[], ${json}::text::jsonb) WHERE id = ${decodeId(ids[i]!)!.uuid}`;
      await set(10, "n", "2e300");
      await set(11, "n", "1.2345678901234567e-30");
      await set(12, "n", "5e-324");
      await set(13, "n", "-1.7976931348623157e308");
      await set(14, "d", '"0000-01-01"');
      await set(14, "dt", '"0000-06-01T00:00:00.000Z"');
    });
  });

  /** Follows next_cursor (or X-Next-Cursor) to the end and returns every ID seen, in order. */
  async function pageAll(fetchPage: (cursor?: string) => Promise<{ ids: string[]; next: string | null }>): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 100; i++) {
      const p = await fetchPage(cursor);
      seen.push(...p.ids);
      if (!p.next) return seen;
      expect(p.next.length).toBeLessThanOrEqual(MAX_CURSOR);
      cursor = p.next;
    }
    throw new Error("did not finish");
  }

  it("sees every record exactly once under every sort, through query, list and export", async () => {
    const sorts = [[{ field: "t" }], [{ field: "t", dir: "desc" }], [{ field: "n" }], [{ field: "n", dir: "desc" }], [{ field: "d" }], [{ field: "dt", dir: "desc" }],
      [{ field: "t" }, { field: "n", dir: "desc" }], [{ field: "n" }, { field: "d" }, { field: "dt" }], [{ field: "dt" }, { field: "t", dir: "desc" }, { field: "n" }],
      [{ field: "d", dir: "desc" }, { field: "t" }, { field: "code" }]];
    // A fresh key per sort: the paging takes more requests than one key's burst.
    const fresh = async () => (await memberWithKey(w, "member", OPS)).key;
    for (const sort of sorts) {
      const key = await fresh();
      const all = await call("POST", "/v1/query", { key, body: { object: "sample", sort, limit: 200 } });
      expect(all.status, JSON.stringify(all.json)).toBe(200);
      const order = all.json.data.map((r: { id: string }) => r.id);
      expect([...order].sort()).toEqual([...ids].sort());
      for (const limit of [1, 3]) {
        const seen = await pageAll(async (cursor) => {
          const r = await call("POST", "/v1/query", { key, body: { object: "sample", sort, limit, cursor } });
          expect(r.status, `${JSON.stringify(sort)} ${JSON.stringify(r.json)}`).toBe(200);
          return { ids: r.json.data.map((x: { id: string }) => x.id), next: r.json.next_cursor };
        });
        expect(seen, JSON.stringify(sort)).toEqual(order);
      }
    }
    const sortParam = "t,-n";
    const key = await fresh();
    const viaQuery = (await call("POST", "/v1/query", { key, body: { object: "sample", sort: [{ field: "t" }, { field: "n", dir: "desc" }], limit: 200 } })).json.data.map((r: { id: string }) => r.id);
    expect(await pageAll(async (cursor) => {
      const r = await call("GET", `/v1/objects/sample/records?sort=${sortParam}&limit=2${cursor ? `&cursor=${cursor}` : ""}`, { key });
      expect(r.status).toBe(200);
      return { ids: r.json.data.map((x: { id: string }) => x.id), next: r.json.next_cursor };
    })).toEqual(viaQuery);
    expect(await pageAll(async (cursor) => {
      const r = await call("GET", `/v1/objects/sample/export?format=ndjson&sort=${sortParam}&limit=2${cursor ? `&cursor=${cursor}` : ""}`, { key });
      expect(r.status).toBe(200);
      const lines = String(r.json).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string });
      return { ids: lines.map((x) => x.id), next: r.headers.get("x-next-cursor") };
    })).toEqual(viaQuery);
  });

  it("refuses sorting by long text, and bounds new numbers and dates to what sorts and casts cleanly", async () => {
    const key = (await memberWithKey(w, "member", OPS)).key; // the paging above spent the first key's burst
    expect((await call("POST", "/v1/query", { key, body: { object: "sample", sort: [{ field: "notes" }] } })).status).toBe(422);
    for (const values of [{ n: 2e300 }, { n: -1e16 }, { d: "0000-01-01" }, { dt: "0000-03-01T00:00:00Z" }]) {
      expect((await call("POST", "/v1/objects/sample/records", { key, body: values })).status, JSON.stringify(values)).toBe(422);
    }
    // A stored year 0000 reads as empty in filters and aggregates instead of failing them.
    expect((await call("POST", "/v1/query", { key, body: { object: "sample", where: { field: "d", op: "lt", value: "2000-01-01" } } })).json.data).toHaveLength(1);
    expect((await call("POST", "/v1/aggregate", { key, body: { object: "sample", measures: [{ op: "min", field: "d" }, { op: "max", field: "n" }] } })).json.data[0].values)
      .toEqual({ min_d: "0001-01-01", max_n: 2e300 });
  });

  it("types filter values by their field, so a postcode keeps its leading zero", async () => {
    const key = (await memberWithKey(w, "member", OPS)).key;
    const list = await call("GET", "/v1/objects/sample/records?filter[code]=02139", { key });
    expect(list.json.data.map((r: { code: string }) => r.code)).toEqual(["02139"]);
    const agg = await call("POST", "/v1/aggregate", { key, body: { object: "sample", where: { field: "code", op: "eq", value: "02139" } } });
    expect(agg.json.data[0].count).toBe(1);
    // Numbers given as text are typed by a number field, including in lists from a URL.
    expect((await call("GET", "/v1/objects/sample/records?filter[n][gt]=999999999999999&filter[n][lte]=1000000000000000", { key })).json.data).toHaveLength(1);
    expect((await call("GET", "/v1/objects/sample/records?filter[n][in]=0,1", { key })).json.data).toHaveLength(2);
    expect((await call("GET", "/v1/objects/sample/records?filter[n]=abc", { key })).status).toBe(422);
  });
});

describe("aggregate and count cost", () => {
  it("bounds the records an aggregate looks at, and says when it did", async () => {
    const before = AGGREGATE_ROWS.max;
    try {
      AGGREGATE_ROWS.max = 2;
      const capped = await call("POST", "/v1/aggregate", { key: ws.keys.ops, body: { object: "deal", group_by: [{ field: "name" }] } });
      expect(capped.status).toBe(200);
      expect(capped.json.rows_capped).toBe(true);
      expect(capped.json.data.reduce((s: number, g: { count: number }) => s + g.count, 0)).toBe(2);
      const fits = await call("POST", "/v1/aggregate", { key: ws.keys.ops, body: { object: "deal", where: { field: "name", op: "eq", value: "One" } } });
      expect(fits.json).toMatchObject({ rows_capped: false, data: [{ count: 1 }] });
    } finally {
      AGGREGATE_ROWS.max = before;
    }
    expect((await call("POST", "/v1/aggregate", { key: ws.keys.ops, body: { object: "deal" } })).json).toMatchObject({ rows_capped: false, data: [{ count: 3 }] });
  });

  it("charges a count the same on GET and POST, and an aggregate by its shape", () => {
    const cost = (method: string, path: string, body: unknown, query: unknown = {}) => {
      const r = routes.find((x) => x.method === method && x.path === path)!;
      return r.cost ? r.cost(body as never, query as never) : 1;
    };
    expect(cost("GET", "/v1/objects/:object/records", undefined, { count: "true" })).toBe(cost("POST", "/v1/query", { count: true }));
    expect(cost("GET", "/v1/objects/:object/records", undefined, {})).toBe(1);
    const plain = cost("POST", "/v1/aggregate", { object: "deal" });
    const wide = cost("POST", "/v1/aggregate", { object: "deal", group_by: [{ field: "a" }, { field: "b" }], measures: [{ op: "sum", field: "c" }, { op: "max", field: "c" }] });
    expect(wide).toBe(plain + 4);
    expect(cost("POST", "/v1/aggregate", { view: "v_x" })).toBeGreaterThan(plain);
  });
});

describe("odds and ends", () => {
  it("shows a disabled member's name through include, but not their email", async () => {
    const m = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email: uniqueEmail("left"), name: "Left Person", role: "member" } });
    const deal = await create(ws.keys.ops, "deal", { name: "Owned", primary_contact: contactId, owner: m.json.data.id });
    const before = await call("GET", `/v1/objects/deal/records/${deal.id}?include=owner,owner.email`, { key: ws.keys.ops });
    expect(before.json.data.included.owner.email).toMatch(/^left-/);
    expect((await call("PATCH", `/v1/members/${m.json.data.id}`, { key: ws.keys.admin, body: { active: false } })).status).toBe(200);
    const after = await call("GET", `/v1/objects/deal/records/${deal.id}?include=owner,owner.email`, { key: ws.keys.ops });
    expect(after.json.data.included.owner).toMatchObject({ id: m.json.data.id, display_name: "Left Person", email: null });
  });

  it("unlocks views:manage from the admin scope as well as ops:write, without making an admin-only key read records", async () => {
    const both = await memberWithKey(ws, "admin", ["admin", "ops:read"]);
    expect((await call("POST", "/v1/views", { key: both.key, body: { object: "deal", name: "Admin curated", shared: true } })).status).toBe(201);
    const adminOnly = await memberWithKey(ws, "admin", ["admin"]);
    expect((await call("POST", "/v1/views", { key: adminOnly.key, body: { object: "deal", name: "Nope", shared: true } })).status).toBe(403);
    expect((await call("GET", "/v1/objects/deal/records", { key: adminOnly.key })).status).toBe(403);
    const readOnly = await memberWithKey(ws, "admin", ["ops:read"]);
    expect((await call("POST", "/v1/views", { key: readOnly.key, body: { object: "deal", name: "Nope", shared: true } })).status).toBe(403);
    // A role whose only configuration permission is views:manage still gets no admin key.
    const curator = await role(ws, ["records:read", "views:manage"]);
    await expect(memberWithKey(ws, curator.key, ["admin"])).rejects.toThrow(/does not allow: admin/);
  });

  it("keeps a field already named `included` intact: include is refused on that object with a clear message", async () => {
    const w = await newWorkspace("Included field");
    expect((await call("POST", "/v1/objects/contact/fields", { key: w.keys.admin, body: { api_name: "included_tmp", type: "text" } })).status).toBe(201);
    const c = await create(w.keys.ops, "contact", { email: uniqueEmail("inc"), included_tmp: "kept value" });
    await inTenant(w.tenantId, async (tx) => {
      await tx`UPDATE fields SET api_name = 'included' WHERE api_name = 'included_tmp'`;
      await bumpSchema(tx);
    });
    expect((await call("GET", `/v1/objects/contact/records/${c.id}`, { key: w.keys.ops })).json.data.included).toBe("kept value");
    const r = await call("GET", `/v1/objects/contact/records/${c.id}?include=account`, { key: w.keys.ops });
    expect(r.status).toBe(422);
    expect(r.json.detail).toMatch(/field named "included"/);
    expect((await call("POST", "/v1/query", { key: w.keys.ops, body: { object: "contact", include: ["account"] } })).status).toBe(422);
    expect((await call("GET", "/v1/objects/deal/records?include=account", { key: w.keys.ops })).status).toBe(200);
  });

  it("gives views IDs that no object's records can have, even an object that took the prefix vw before it was reserved", async () => {
    const w = await newWorkspace("View prefix");
    const made = await call("POST", "/v1/objects", { key: w.keys.admin, body: { api_name: "gadget", label: "Gadget", plural_label: "Gadgets", id_prefix: "gdg",
      fields: [{ api_name: "title", type: "text" }] } });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    await inTenant(w.tenantId, async (tx) => {
      await tx`UPDATE objects SET id_prefix = 'vw' WHERE api_name = 'gadget'`;
      await bumpSchema(tx);
    });
    const rec = await create(w.keys.ops, "gadget", { title: "G" });
    expect(rec.id).toMatch(/^vw_/);
    const v = await call("POST", "/v1/views", { key: w.keys.ops, body: { object: "gadget", name: "Gadgets" } });
    expect(v.status).toBe(201);
    const schema = await withTenant(w.tenantId, (tx) => loadSchema(tx));
    expect(schema.byPrefix.has(decodeId(v.json.data.id)!.prefix)).toBe(false);
    expect((await call("GET", `/v1/records/${v.json.data.id}`, { key: w.keys.ops })).status).toBe(404);
    expect((await call("GET", `/v1/views/${rec.id}`, { key: w.keys.ops })).status).toBe(404);
    expect((await call("GET", `/v1/views/${v.json.data.id}`, { key: w.keys.ops })).json.data.name).toBe("Gadgets");
  });

  it("holds the shared-view cap under concurrent creates", async () => {
    const w = await newWorkspace("View cap");
    await inTenant(w.tenantId, async (tx) => {
      const [deal] = await tx<{ id: string }[]>`SELECT id FROM objects WHERE api_name = 'deal'`;
      await tx`INSERT INTO views (tenant_id, id, object_id, name, shared, definition)
        SELECT ${w.tenantId}, gen_random_uuid(), ${deal!.id}, 'Filler ' || g, true, '{}' FROM generate_series(1, 499) g`;
    });
    // A few rounds, each one place short of the cap: without serialising, several creates pass the count together.
    for (let round = 0; round < 3; round++) {
      await inTenant(w.tenantId, (tx) => tx`DELETE FROM views WHERE name LIKE 'Race %'`);
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
        call("POST", "/v1/views", { key: w.keys.ops, body: { object: "deal", name: `Race ${round}.${i}`, shared: true } })));
      expect(results.map((r) => r.status).sort(), `round ${round}`).toEqual([201, ...Array.from({ length: 9 }, () => 422)]);
    }
  });
});
