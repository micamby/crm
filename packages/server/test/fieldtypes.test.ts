import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetRateLimiter } from "../src/api/app.js";
import type { FieldType } from "../src/core/catalog.js";
import { COUNTRIES } from "../src/core/countries.js";
import {
  FIELD_TYPES, formatAddress, formatDuration, parseDuration, plainDecimal, shapeProblem, storedJsonBytes, TYPE_INFO, type FilterOp, type MeasureOp,
} from "../src/core/fieldtypes.js";
import { app, call, create, memberWithKey, newWorkspace, validate, type Workspace } from "./helpers.js";

/**
 * Every field type, old and new, through every layer, from one table: a type added to the registry
 * (core/fieldtypes.ts TYPE_INFO) without a case here fails the first test, and each case is checked
 * against what the registry declares (filter operators, sorting, grouping, measures, uniqueness), so a
 * declaration and the behaviour can't drift apart.
 */

interface Case {
  /** Field definition besides api_name and type. */
  def?: Record<string, unknown>;
  /** A valid input, what reading it back gives, and a second value that sorts after it. */
  value: unknown; expected?: unknown; other: unknown; otherExpected?: unknown;
  /** Inputs refused with 422. */
  bad: unknown[];
  /** A filter value that matches `value` with eq (and in, gt, …), and the field (or part, or path) the filter names. */
  filter?: { field?: (name: string) => string; value: unknown };
  /** Sort and group by this instead of the field itself (an address's parts). */
  sortBy?: (name: string) => string;
  groupBy?: (name: string) => string;
}

let contactA = "";
let contactB = "";

const CASES: Record<FieldType, Case> = {
  text: { value: "alpha", other: "beta", bad: [5, "x".repeat(2_001), { a: 1 }] },
  long_text: { value: "alpha long", other: "beta long", bad: [5, ["a"]] },
  number: { value: 10, other: 20, bad: ["abc", 1e16, true] },
  currency: { value: 10.5, other: 20.25, bad: ["x", 1e14] },
  boolean: { value: false, other: true, bad: ["yes", 1] },
  date: { value: "2024-01-02", other: "2024-02-03", bad: ["2024-02-31", "0000-01-01", 20240102] },
  datetime: { value: "2024-01-02T03:04:05.000Z", other: "2024-02-02T03:04:05.000Z", bad: ["nope", "99999-01-01T00:00:00Z"] },
  single_select: { def: { options: { values: [{ key: "a", label: "A" }, { key: "b", label: "B" }] } }, value: "a", other: "b", bad: ["c", 1] },
  multi_select: { def: { options: { values: [{ key: "a", label: "A" }, { key: "b", label: "B" }] } }, value: ["b"], other: ["a"], bad: ["a", ["c"]],
    filter: { value: "b" } },
  email: { value: "a@example.com", other: "b@example.com", bad: ["nope", 5] },
  phone: { value: "+1 555 0100", other: "+1 555 0200", bad: ["abc", 5] },
  url: { value: "https://a.example", other: "https://b.example", bad: ["ftp://x.example", "nope"] },
  relation: { def: { options: { to: "contact" } }, value: "", other: "", bad: ["con_bogus", 5, "acct_00000000000000000000000000"] },
  status: { def: { options: { values: [{ key: "closed", label: "Closed" }, { key: "open", label: "Open" }] } }, value: "closed", other: "open", bad: ["gone"] },
  address: {
    value: { line1: " 1 Main St ", city: "Austin", region: "TX", postal_code: "73301", country: "us", display: "ignored" },
    expected: { line1: "1 Main St", line2: null, city: "Austin", region: "TX", postal_code: "73301", country: "US", display: "1 Main St, Austin, TX 73301, United States" },
    other: { city: "Boston", country: "US" },
    otherExpected: { line1: null, line2: null, city: "Boston", region: null, postal_code: null, country: "US", display: "Boston, United States" },
    bad: ["1 Main St", ["Austin"], { country: "ZZ" }, { country: "USA" }, { city: 5 }, { town: "x" }, { city: "a\nb" }, { city: "x".repeat(101) },
      { city: "nul\u0000" }, JSON.parse('{"__proto__": {"city": "x"}, "city": "y"}'), { display: 5 }],
    filter: { field: (n) => `${n}.city`, value: "Austin" }, sortBy: (n) => `${n}.city`, groupBy: (n) => `${n}.country`,
  },
  json: {
    value: { a: 1, b: { c: "x" }, list: [1, "two", null] }, other: [1, 2, 3],
    bad: [JSON.parse('{"__proto__": 1}'), { constructor: { prototype: 1 } }, { s: "nul\u0000" }, "x".repeat(17_000), deep(12)],
    filter: { field: (n) => `${n}.b.c`, value: "x" },
  },
  rating: { value: 3, other: 5, bad: [0, 6, 2.5, "x", -1] },
  percent: { value: "12.5%", expected: 12.5, other: 50, bad: [101, -1, "abc", "12.5%%", true], filter: { value: "12.5%" } },
  duration: { value: "PT1H30M", expected: 5400, other: 7200, bad: ["P1Y", "P1M", -5, 1.5, "PT", "PT1.5S", "1h"], filter: { value: "PT1H30M" } },
};

function deep(n: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < n; i++) v = { v };
  return v;
}

const name = (t: FieldType) => `v_${t}`;
const ALL_OPS: FilterOp[] = ["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "contains", "starts_with", "is_null"];
const MEASURES: MeasureOp[] = ["sum", "avg", "min", "max"];

let ws: Workspace;
let recA: Record<string, unknown> & { id: string };
let recB: Record<string, unknown> & { id: string };
const valueOf = (t: FieldType, which: "a" | "b") => (t === "relation" ? (which === "a" ? contactA : contactB) : which === "a" ? CASES[t].value : CASES[t].other);
const expectedOf = (t: FieldType, which: "a" | "b") => {
  const c = CASES[t];
  if (t === "relation") return which === "a" ? contactA : contactB;
  return which === "a" ? ("expected" in c ? c.expected : c.value) : ("otherExpected" in c ? c.otherExpected : c.other);
};
const query = (key: string, body: Record<string, unknown>) => call("POST", "/v1/query", { key, body: { object: "specimen", ...body } });

// Each test makes many calls with one key; rate limits are tested elsewhere.
beforeEach(() => resetRateLimiter());

beforeAll(async () => {
  ws = await newWorkspace("Field types");
  contactA = (await create(ws.keys.ops, "contact", { email: `fta-${Date.now()}@example.com` })).id;
  contactB = (await create(ws.keys.ops, "contact", { email: `ftb-${Date.now()}@example.com` })).id;
  const r = await call("POST", "/v1/objects", { key: ws.keys.admin, body: {
    api_name: "specimen", id_prefix: "spec", fields: [{ api_name: "label", type: "text" }, ...FIELD_TYPES.map((t) => ({ api_name: name(t), type: t, ...CASES[t].def }))],
  } });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  recA = await create(ws.keys.ops, "specimen", { label: "A", ...Object.fromEntries(FIELD_TYPES.map((t) => [name(t), valueOf(t, "a")])) });
  recB = await create(ws.keys.ops, "specimen", { label: "B", ...Object.fromEntries(FIELD_TYPES.map((t) => [name(t), valueOf(t, "b")])) });
});

describe("the field type registry", () => {
  it("has a case here for every type, and every type in the API's enums", async () => {
    expect(Object.keys(CASES).sort()).toEqual([...FIELD_TYPES].sort());
    const doc = (await call("GET", "/v1/openapi.json", { key: ws.keys.admin })).json;
    const body = doc.paths["/v1/objects/{object}/fields"].post.requestBody.content["application/json"].schema;
    expect([...body.properties.type.enum].sort()).toEqual([...FIELD_TYPES].sort());
  });

  it("carries the officially assigned ISO 3166-1 alpha-2 codes", () => {
    expect(COUNTRIES.size).toBe(249);
    expect(COUNTRIES.get("DE")).toBe("Germany");
    expect(COUNTRIES.has("XK")).toBe(false);
    expect(COUNTRIES.has("__proto__")).toBe(false);
  });

  it("parses and formats durations and addresses", () => {
    expect(parseDuration("PT1H30M")).toBe(5400);
    expect(parseDuration("p1dt1s")).toBe(86_401);
    expect(parseDuration("P2W")).toBe(1_209_600);
    expect(parseDuration("90")).toBe(90);
    expect(typeof parseDuration("P1Y")).toBe("string");
    expect(typeof parseDuration("P")).toBe("string");
    expect(typeof parseDuration("PT1H".repeat(20))).toBe("string");
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(93_784)).toBe("1d 2h 3m 4s");
    expect(formatDuration(5_400)).toBe("1h 30m");
    expect(formatAddress({ line1: "1 Main St", city: "Paris", postal_code: "75001", country: "FR" })).toBe("1 Main St, Paris, 75001, France");
    expect(formatAddress({})).toBe("");
  });

  it("checks json shapes as a small declarative subset", () => {
    expect(shapeProblem({ type: "object", required: ["id"], properties: { id: "string" }, additional_properties: false })).toBeNull();
    expect(shapeProblem({ $ref: "#/x" })).toMatch(/takes type/);
    expect(shapeProblem({ type: "array", required: ["a"] })).toMatch(/objects only/);
    expect(shapeProblem({ properties: { __proto__x: "string", constructor: "string" } })).toMatch(/not a usable key/);
    expect(shapeProblem({ required: Array.from({ length: 51 }, (_, i) => `k${i}`) })).toMatch(/at most 50/);
  });
});

describe.each(FIELD_TYPES)("%s fields", (t) => {
  const c = CASES[t];
  const f = name(t);
  const info = TYPE_INFO[t];

  it("create and read back the normalized value", async () => {
    expect(recA[f]).toEqual(expectedOf(t, "a"));
    expect(recB[f]).toEqual(expectedOf(t, "b"));
    const got = await call("GET", `/v1/objects/specimen/records/${recA.id}`, { key: ws.keys.ops });
    expect(got.json.data[f]).toEqual(expectedOf(t, "a"));
  });

  it("refuses hostile and wrong-shaped values with 422", async () => {
    for (const bad of c.bad) {
      const r = await call("POST", "/v1/objects/specimen/records", { key: ws.keys.ops, body: { [f]: bad } });
      expect(r.status, `${t} ${JSON.stringify(bad).slice(0, 80)}: ${JSON.stringify(r.json).slice(0, 200)}`).toBe(422);
    }
  });

  it("updates, clears with null, and bulk-updates", async () => {
    const rec = await create(ws.keys.ops, "specimen", { [f]: valueOf(t, "a") });
    const up = await call("PATCH", `/v1/objects/specimen/records/${rec.id}`, { key: ws.keys.ops, body: { [f]: valueOf(t, "b") } });
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    expect(up.json.data[f]).toEqual(expectedOf(t, "b"));
    const cleared = await call("PATCH", `/v1/objects/specimen/records/${rec.id}`, { key: ws.keys.ops, body: { [f]: null } });
    expect(cleared.json.data[f]).toBeNull();
    const bulk = await call("POST", "/v1/objects/specimen/records/bulk_update", { key: ws.keys.ops, body: { ids: [rec.id], values: { [f]: valueOf(t, "a") }, dry_run: false } });
    expect(bulk.status, JSON.stringify(bulk.json).slice(0, 300)).toBe(200);
    expect((await call("GET", `/v1/objects/specimen/records/${rec.id}`, { key: ws.keys.ops })).json.data[f]).toEqual(expectedOf(t, "a"));
    await call("DELETE", `/v1/objects/specimen/records/${rec.id}`, { key: ws.keys.ops });
  });

  it("filters with exactly the operators the registry declares", async () => {
    const fv = c.filter?.value ?? valueOf(t, "a");
    for (const op of ALL_OPS) {
      const value = op === "is_null" ? true : op === "in" || op === "not_in" ? [fv] : op === "contains" || op === "starts_with" ? (typeof fv === "string" ? fv.slice(0, 4) : "abcd") : fv;
      const r = await query(ws.keys.ops, { where: { field: f, op, value } });
      expect(r.status, `${t} ${op}: ${JSON.stringify(r.json).slice(0, 200)}`).toBe(info.ops.includes(op) ? 200 : 422);
    }
    const target = c.filter?.field?.(f) ?? f;
    const op = t === "multi_select" ? "contains" : "eq";
    const hit = await query(ws.keys.ops, { where: { field: target, op, value: fv } });
    expect(hit.status, JSON.stringify(hit.json).slice(0, 300)).toBe(200);
    expect(hit.json.data.map((r: { id: string }) => r.id)).toContain(recA.id);
    expect(hit.json.data.map((r: { id: string }) => r.id)).not.toContain(recB.id);
    const empty = await query(ws.keys.ops, { where: { field: f, op: "is_null", value: false } });
    expect(empty.json.data.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([recA.id, recB.id]));
  });

  it("sorts only when the registry says so, and pages with a cursor", async () => {
    const r = await query(ws.keys.ops, { sort: [{ field: f }], where: { field: "label", op: "in", value: ["A", "B"] } });
    expect(r.status, JSON.stringify(r.json).slice(0, 200)).toBe(info.sort ? 200 : 422);
    const by = c.sortBy?.(f) ?? (info.sort ? f : null);
    if (!by) return;
    const first = await query(ws.keys.ops, { sort: [{ field: by }], where: { field: "label", op: "in", value: ["A", "B"] }, limit: 1 });
    expect(first.status, JSON.stringify(first.json).slice(0, 200)).toBe(200);
    expect(first.json.data[0].id).toBe(recA.id);
    const next = await query(ws.keys.ops, { sort: [{ field: by }], where: { field: "label", op: "in", value: ["A", "B"] }, limit: 1, cursor: first.json.next_cursor });
    expect(next.json.data[0].id).toBe(recB.id);
  });

  it("groups and measures only as declared", async () => {
    const g = await call("POST", "/v1/aggregate", { key: ws.keys.ops, body: { object: "specimen", group_by: [{ field: f }] } });
    expect(g.status, JSON.stringify(g.json).slice(0, 200)).toBe(info.group ? 200 : 422);
    for (const op of MEASURES) {
      const m = await call("POST", "/v1/aggregate", { key: ws.keys.ops, body: { object: "specimen", measures: [{ op, field: f }] } });
      expect(m.status, `${t} ${op}: ${JSON.stringify(m.json).slice(0, 200)}`).toBe(info.measures.includes(op) ? 200 : 422);
    }
    const count = await call("POST", "/v1/aggregate", { key: ws.keys.ops, body: { object: "specimen", measures: [{ op: "count", field: f }] } });
    expect(count.status).toBe(200);
    if (c.groupBy) {
      const parts = await call("POST", "/v1/aggregate", { key: ws.keys.ops, body: { object: "specimen", group_by: [{ field: c.groupBy(f) }], where: { field: "label", op: "in", value: ["A", "B"] } } });
      expect(parts.status, JSON.stringify(parts.json).slice(0, 200)).toBe(200);
      expect(parts.json.data).toEqual([expect.objectContaining({ group: { [c.groupBy(f)]: "US" }, count: 2 })]);
    }
  });

  it("can be unique only when declared", async () => {
    const r = await call("POST", "/v1/objects/specimen/fields", { key: ws.keys.admin, body: { api_name: `u_${t}`, type: t, unique: true, ...c.def, dry_run: true } });
    expect(r.status, JSON.stringify(r.json).slice(0, 200)).toBe(info.unique ? 200 : 422);
  });

  it("takes a default, and required is enforced", async () => {
    if (t === "relation") return; // a relation's default would be a record ID of one workspace
    const obj = `req_${t}`;
    const r = await call("POST", "/v1/objects", { key: ws.keys.admin, body: { api_name: obj, fields: [
      { api_name: "label", type: "text" }, { api_name: "v", type: t, required: true, ...c.def }, { api_name: "d", type: t, default: c.value, ...c.def }] } });
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(201);
    expect((await call("POST", `/v1/objects/${obj}/records`, { key: ws.keys.ops, body: { label: "x" } })).status).toBe(422);
    const ok = await call("POST", `/v1/objects/${obj}/records`, { key: ws.keys.ops, body: { v: c.value } });
    expect(ok.status, JSON.stringify(ok.json).slice(0, 300)).toBe(201);
    expect(ok.json.data.d).toEqual(expectedOf(t, "a"));
    const badDefault = await call("POST", `/v1/objects/${obj}/fields`, { key: ws.keys.admin, body: { api_name: "bad_default", type: t, default: c.bad[0], ...c.def } });
    expect(badDefault.status).toBe(422);
  });

  it("is encrypted when restricted: redacted without restricted:read, and never filtered, sorted or grouped", async () => {
    if (t === "relation") return; // relations can't be restricted (refused when the field is created)
    const obj = `vault_${t}`;
    const r = await call("POST", "/v1/objects", { key: ws.keys.admin, body: { api_name: obj, fields: [
      { api_name: "label", type: "text" }, { api_name: "secret", type: t, sensitivity: "restricted", ...c.def }] } });
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(201);
    const rec = await create(ws.keys.admin, obj, { label: "x", secret: c.value });
    expect(rec.secret).toEqual(expectedOf(t, "a"));
    expect((await call("GET", `/v1/objects/${obj}/records/${rec.id}`, { key: ws.keys.ops })).json.data.secret).toBe("[restricted]");
    const filterField = c.filter?.field?.("secret") ?? "secret";
    for (const body of [{ where: { field: filterField, op: "is_null" } }, { sort: [{ field: c.sortBy?.("secret") ?? "secret" }] }]) {
      expect((await call("POST", "/v1/query", { key: ws.keys.admin, body: { object: obj, ...body } })).status).toBe(422);
    }
    expect((await call("POST", "/v1/aggregate", { key: ws.keys.admin, body: { object: obj, group_by: [{ field: c.groupBy?.("secret") ?? "secret" }] } })).status).toBe(422);
    const exported = await call("GET", `/v1/objects/${obj}/export`, { key: ws.keys.ops });
    expect(String(exported.json)).toContain("[restricted]");
    expect(JSON.stringify(exported.json)).not.toContain("Austin");
  });

  it("describes the field and declares it in the OpenAPI record schema", async () => {
    const d = await call("GET", "/v1/objects/specimen", { key: ws.keys.ops });
    const field = d.json.data.fields.find((x: { name: string }) => x.name === f);
    expect(field).toMatchObject({ name: f, type: t });
    if (t === "rating") expect(field.max).toBe(5);
    if (t === "address") expect(field.parts).toEqual(["line1", "line2", "city", "region", "postal_code", "country"]);
    if (t === "duration") expect(field.unit).toBe("seconds");
    if (t === "percent") expect(field).toMatchObject({ unit: "percent", min: 0, max: 100 });
    const doc = (await call("GET", "/v1/openapi.json", { key: ws.keys.ops })).json;
    expect(doc.components.schemas.specimen_record.properties[f]).toBeDefined();
    const one = await call("GET", `/v1/objects/specimen/records/${recA.id}`, { key: ws.keys.ops });
    expect(validate(doc, { $ref: "#/components/schemas/specimen_record" }, one.json.data)).toEqual([]);
  });
});

describe("export and import", () => {
  it("round-trips every type: exported rows re-import as unchanged, and as new records with the same values", async () => {
    const exp = await call("GET", "/v1/objects/specimen/export?filter[label][in]=A,B&sort=label&dir=asc", { key: ws.keys.ops });
    expect(exp.status).toBe(200);
    const csv = exp.json as string;
    const header = csv.split("\r\n")[0]!.split(",");
    expect(header).toEqual(expect.arrayContaining(["v_address.city", "v_address.country", "v_json", "v_rating", "v_duration"]));
    expect(header).not.toContain("v_address");
    const same = await call("POST", "/v1/objects/specimen/import", { key: ws.keys.ops, body: { csv, key: "id", dry_run: false } });
    expect(same.status, JSON.stringify(same.json).slice(0, 500)).toBe(200);
    expect(same.json.counts).toEqual({ create: 0, update: 0, skip: 2, error: 0 });
    // Without the id column every row is a new record, with the same values.
    const created = await call("POST", "/v1/objects/specimen/import", { key: ws.keys.ops, body: { csv, mapping: { id: "" }, dry_run: false } });
    expect(created.status, JSON.stringify(created.json).slice(0, 500)).toBe(200);
    expect(created.json.counts.create).toBe(2);
    for (const [i, src] of [recA, recB].entries()) {
      const copy = (await call("GET", `/v1/objects/specimen/records/${created.json.rows[i].id}`, { key: ws.keys.ops })).json.data;
      for (const t of FIELD_TYPES) expect(copy[name(t)], t).toEqual(src[name(t)]);
    }
  });

  it("refuses an address imported as one column, and bad JSON cells, with 4xx", async () => {
    const whole = await call("POST", "/v1/objects/specimen/import", { key: ws.keys.ops, body: { csv: "label,v_address\nX,Austin\n", dry_run: true } });
    expect(whole.status).toBe(422);
    const json = await call("POST", "/v1/objects/specimen/import", { key: ws.keys.ops, body: { csv: "label,v_json\nX,{not json\n", dry_run: true } });
    expect(json.status).toBe(200);
    expect(json.json.rows[0]).toMatchObject({ action: "error" });
    const proto = await call("POST", "/v1/objects/specimen/import", { key: ws.keys.ops, body: { csv: 'label,v_json\nX,"{""__proto__"": {""x"": 1}}"\n', dry_run: true } });
    expect(proto.json.rows[0]).toMatchObject({ action: "error" });
    const parts = await call("POST", "/v1/objects/specimen/import", { key: ws.keys.ops, body: { csv: "label,v_address.city,v_address.country\nX,Lyon,fr\n", dry_run: false } });
    expect(parts.status, JSON.stringify(parts.json).slice(0, 300)).toBe(200);
    const rec = (await call("GET", `/v1/objects/specimen/records/${parts.json.rows[0].id}`, { key: ws.keys.ops })).json.data;
    expect(rec.v_address).toMatchObject({ city: "Lyon", country: "FR", display: "Lyon, France" });
  });
});

describe("search, filters from the URL, json paths and retyping", () => {
  it("puts an address's parts in search text", async () => {
    const r = await call("GET", "/v1/search?q=austin&objects=specimen", { key: ws.keys.ops });
    expect(r.status).toBe(200);
    expect(r.json.data.map((x: { id: string }) => x.id)).toContain(recA.id);
  });

  it("takes address parts and json paths in filter[...] query parameters", async () => {
    const a = await call("GET", "/v1/objects/specimen/records?filter[v_address.country]=us&filter[v_address.city]=Austin", { key: ws.keys.ops });
    expect(a.status).toBe(200);
    // recA, and copies of it made by the import test above; never recB.
    const only = (r: { json: { data: { id: string }[] } }) => {
      const found = r.json.data.map((x) => x.id);
      expect(found).toContain(recA.id);
      expect(found).not.toContain(recB.id);
    };
    only(a);
    expect(a.json.data.every((x: { v_address: { city: string } }) => x.v_address.city === "Austin")).toBe(true);
    only(await call("GET", "/v1/objects/specimen/records?filter[v_json.b.c]=x", { key: ws.keys.ops }));
    only(await query(ws.keys.ops, { where: { field: "v_json.a", op: "eq", value: 1 } }));
    only(await query(ws.keys.ops, { where: { field: "v_json.list.1", op: "eq", value: "two" } }));
    expect((await query(ws.keys.ops, { where: { field: "v_json.a", op: "eq", value: "1" } })).json.data).toEqual([]);
    for (const bad of [{ field: "v_json.a", op: "gt", value: 1 }, { field: "v_json.a", op: "eq", value: { x: 1 } }, { field: "v_json.a.b.c.d.e", op: "eq", value: 1 },
      { field: "v_json.$x", op: "eq", value: 1 }, { field: "v_address.town", op: "eq", value: "x" }, { field: "v_address.city.x", op: "eq", value: "x" },
      { field: "v_json.a", op: "eq", value: "x".repeat(2_001) }, { field: "v_rating.a", op: "eq", value: 1 }]) {
      const r = await query(ws.keys.ops, { where: bad });
      expect(r.status, JSON.stringify(bad)).toBe(422);
    }
    const missing = await query(ws.keys.ops, { where: { field: "v_json.nothere", op: "is_null" } });
    expect(missing.json.data.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([recA.id, recB.id]));
  });

  it("refuses to sort by a whole address, pointing at its parts", async () => {
    const r = await query(ws.keys.ops, { sort: [{ field: "v_address" }] });
    expect(r.status).toBe(422);
    expect(r.json.detail).toContain("v_address.country");
  });

  it("raises a rating's max, refuses lowering it, and replaces a json shape", async () => {
    const up = await call("PATCH", "/v1/objects/specimen/fields/v_rating", { key: ws.keys.admin, body: { max: 10 } });
    expect(up.status, JSON.stringify(up.json)).toBe(200);
    expect((await call("PATCH", "/v1/objects/specimen/fields/v_rating", { key: ws.keys.admin, body: { max: 4 } })).status).toBe(422);
    expect((await call("PATCH", "/v1/objects/specimen/fields/v_text", { key: ws.keys.admin, body: { max: 4 } })).status).toBe(422);
    const shaped = await call("PATCH", "/v1/objects/specimen/fields/v_json", { key: ws.keys.admin, body: { shape: { type: "object", required: ["a"] } } });
    expect(shaped.status, JSON.stringify(shaped.json)).toBe(200);
    expect((await call("POST", "/v1/objects/specimen/records", { key: ws.keys.ops, body: { v_json: { b: 1 } } })).status).toBe(422);
    expect((await call("POST", "/v1/objects/specimen/records", { key: ws.keys.ops, body: { v_json: { a: 1 } } })).status).toBe(201);
    expect((await call("PATCH", "/v1/objects/specimen/fields/v_json", { key: ws.keys.admin, body: { shape: { $schema: "x" } } })).status).toBe(422);
    expect((await call("PATCH", "/v1/objects/specimen/fields/v_json", { key: ws.keys.admin, body: { shape: null } })).status).toBe(200);
  });

  it("refuses options and rules a type doesn't take", async () => {
    for (const body of [{ api_name: "x1", type: "text", options: { max: 3 } }, { api_name: "x2", type: "rating", options: { max: 11 } },
      { api_name: "x3", type: "rating", options: { max: 2.5 } }, { api_name: "x4", type: "number", options: { shape: {} } },
      { api_name: "x5", type: "rating", validation: { min: 1 } }, { api_name: "x6", type: "json", validation: { max_length: 5 } },
      { api_name: "x7", type: "duration", validation: { min: -1 } }, { api_name: "x8", type: "address", unique: true },
      { api_name: "x9", type: "json", options: { shape: { type: "object", properties: { a: "date" } } } }, { api_name: "x10", type: "nope" }]) {
      const r = await call("POST", "/v1/objects/specimen/fields", { key: ws.keys.admin, body });
      expect(r.status, JSON.stringify(body)).toBe(422);
    }
    expect((await call("POST", "/v1/objects", { key: ws.keys.admin, body: { api_name: "jsonname", display_field: "j", fields: [{ api_name: "j", type: "json" }] } })).status).toBe(422);
  });

  it("retypes rating, percent and duration to number through the schema document, keeping values", async () => {
    const add = await call("POST", "/v1/objects", { key: ws.keys.admin, body: { api_name: "retypes", fields: [
      { api_name: "r", type: "rating" }, { api_name: "p", type: "percent" }, { api_name: "d", type: "duration" }, { api_name: "a", type: "address" }] } });
    expect(add.status).toBe(201);
    const rec = await create(ws.keys.ops, "retypes", { r: 4, p: 55.5, d: 60 });
    const doc = (await call("GET", "/v1/schema/export", { key: ws.keys.admin })).json;
    const o = doc.objects.find((x: { name: string }) => x.name === "retypes");
    for (const f of o.fields) if (["r", "p", "d"].includes(f.name)) f.type = "number";
    const a = o.fields.find((f: { name: string }) => f.name === "a");
    a.type = "text";
    const blocked = await call("POST", "/v1/schema/apply", { key: ws.keys.admin, body: { document: doc }, headers: { "If-Match": `"${doc.schema_version}"` } });
    expect(blocked.status).toBe(422);
    a.type = "address";
    for (const f of o.fields) delete f.max;
    const ok = await call("POST", "/v1/schema/apply", { key: ws.keys.admin, body: { document: doc }, headers: { "If-Match": `"${doc.schema_version}"` } });
    expect(ok.status, JSON.stringify(ok.json).slice(0, 400)).toBe(200);
    const after = (await call("GET", `/v1/objects/retypes/records/${rec.id}`, { key: ws.keys.ops })).json.data;
    expect(after).toMatchObject({ r: 4, p: 55.5, d: 60 });
    expect((await call("PATCH", `/v1/objects/retypes/records/${rec.id}`, { key: ws.keys.ops, body: { p: 250 } })).status).toBe(422);
  });
});

describe("hostile values", () => {
  it("never answer with a 500 through filters, sorts, cursors, aggregates, imports and the schema document", async () => {
    const statuses: [string, number][] = [];
    const q = async (label: string, body: Record<string, unknown>) => statuses.push([label, (await query(ws.keys.ops, body)).status]);
    for (const [f, values] of [["v_rating", ["x", "1e999", "", [1], { a: 1 }, true, "99999999999999999999"]], ["v_percent", ["12.5%%", "abc", "%", "1e400"]],
      ["v_duration", ["P1Y", "PT", "P", "-PT1H", "PT1.5S", "P".padEnd(41, "T")]], ["v_address.country", [["us"], { a: 1 }]], ["v_address.city", ["x".repeat(2_001)]]] as const) {
      for (const value of values) {
        for (const op of ["eq", "gt", "in", "starts_with"]) await q(`${f} ${op} ${JSON.stringify(value).slice(0, 30)}`, { where: { field: f, op, value: op === "in" ? [value] : value } });
      }
    }
    for (const field of ["v_json.", "v_json..a", ".v_json", "v_json.a.", "v_address.", "v_address..city", "v_json.\u0000"]) await q(`field ${field}`, { where: { field, op: "eq", value: "x" } });
    for (const cursor of [Buffer.from(JSON.stringify({ s: "v_rating:asc", k: ["1e999"], id: recA.id })).toString("base64url"),
      Buffer.from(JSON.stringify({ s: "v_rating:asc", k: [{ a: 1 }], id: recA.id })).toString("base64url")]) {
      await q("cursor", { sort: [{ field: "v_rating" }], cursor });
    }
    await q("sort json path", { sort: [{ field: "v_json.a" }] });
    for (const g of [[{ field: "v_address.line1" }], [{ field: "v_address.country.x" }], [{ field: "v_json.a" }], [{ field: "v_rating", bucket: "day" }]]) {
      statuses.push([`group ${JSON.stringify(g)}`, (await call("POST", "/v1/aggregate", { key: ws.keys.ops, body: { object: "specimen", group_by: g } })).status]);
    }
    statuses.push(["measure avg address part", (await call("POST", "/v1/aggregate", { key: ws.keys.ops, body: { object: "specimen", measures: [{ op: "avg", field: "v_address.city" }] } })).status]);
    for (const csv of ["label,v_address.city,v_address.city\nX,a,b\n", "label,v_address.town\nX,a\n", "label,v_rating\nX,11\n", `label,v_json\nX,"${"[".repeat(70)}"\n`,
      `label,v_json\nX,"""${"x".repeat(20_000)}"""\n`, "label,v_duration\nX,P1M\n", "label,v_address.country\nX,ZZ\n"]) {
      statuses.push([`import ${csv.slice(0, 40)}`, (await call("POST", "/v1/objects/specimen/import", { key: ws.keys.ops, body: { csv, dry_run: true } })).status]);
    }
    const doc = (await call("GET", "/v1/schema/export", { key: ws.keys.admin })).json;
    const spec = doc.objects.find((o: { name: string }) => o.name === "specimen");
    for (const mutate of [(f: Record<string, unknown>) => { if (f.name === "v_json") f.shape = { $ref: "#" }; },
      (f: Record<string, unknown>) => { if (f.name === "v_rating") f.max = 99; }, (f: Record<string, unknown>) => { if (f.name === "v_address") f.type = "json"; },
      (f: Record<string, unknown>) => { if (f.name === "v_rating") f.max = 3; }]) {
      const d = structuredClone(spec);
      d.fields.forEach(mutate);
      const r = await call("POST", "/v1/schema/plan", { key: ws.keys.admin, body: { document: { objects: [d] } } });
      statuses.push([`schema doc ${JSON.stringify(d.fields.find((f: { name: string }) => ["v_json", "v_rating", "v_address"].includes(f.name)) ?? {}).slice(0, 40)}`,
        r.status === 200 && r.json.unsupported.length ? 422 : r.status]);
    }
    const bad = statuses.filter(([, s]) => s >= 500 || s < 400 && s !== 200);
    expect(bad).toEqual([]);
    // The imports are dry runs that report each failing row; everything else is refused outright.
    expect(statuses.filter(([l, s]) => !l.startsWith("import") && s === 200)).toEqual([]);
  });

  it("accept large but legal values at their limits", async () => {
    const big = { list: Array.from({ length: 1_500 }, (_, i) => i) };
    expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThan(16_384);
    const r = await call("POST", "/v1/objects/specimen/records", { key: ws.keys.ops, body: { v_json: big, v_address: { line1: "x".repeat(200), postal_code: "y".repeat(20) },
      v_duration: 1e11, v_percent: "0%", v_rating: "5" } });
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(201);
    expect(r.json.data).toMatchObject({ v_duration: 1e11, v_percent: 0, v_rating: 5 });
    expect((await call("POST", "/v1/objects/specimen/records", { key: ws.keys.ops, body: { v_duration: 1e11 + 1 } })).status).toBe(422);
    expect((await call("POST", "/v1/objects/specimen/records", { key: ws.keys.ops, body: { v_json: { list: Array.from({ length: 4_000 }, (_, i) => i) } } })).status).toBe(422);
  });
});

describe("field-level access on address and json fields", () => {
  it("a member who can't read them gets 403 for parts, paths, sorts, groupings and duplicate rules, and no export columns", async () => {
    const role = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: `hidden_${Date.now()}`, name: "Hidden", permissions: ["records:read", "records:write", "records:archive"],
      fields: { specimen: { v_address: "none", v_json: "none" } } } });
    expect(role.status, JSON.stringify(role.json)).toBe(201);
    const m = await memberWithKey(ws, role.json.data.key, ["ops:read", "ops:write"]);
    for (const where of [{ field: "v_address.city", op: "eq", value: "Austin" }, { field: "v_address", op: "is_null" }, { field: "v_json.b.c", op: "eq", value: "x" },
      { path: ["v_address", "country"], op: "eq", value: "US" }]) {
      expect((await query(m.key, { where })).status, JSON.stringify(where)).toBe(403);
    }
    expect((await call("GET", "/v1/objects/specimen/records?filter[v_address.city]=Austin", { key: m.key })).status).toBe(403);
    expect((await query(m.key, { sort: [{ field: "v_address.city" }] })).status).toBe(403);
    expect((await call("POST", "/v1/aggregate", { key: m.key, body: { object: "specimen", group_by: [{ field: "v_address.country" }] } })).status).toBe(403);
    expect((await call("POST", "/v1/aggregate", { key: m.key, body: { object: "specimen", measures: [{ op: "count", field: "v_json" }] } })).status).toBe(403);
    expect((await call("POST", "/v1/objects/specimen/duplicates", { key: m.key, body: { rules: [["v_address"]] } })).status).toBe(403);
    for (const csv of ["label,v_address.city\nX,Austin\n", "label,v_json\nX,{}\n"]) {
      expect((await call("POST", "/v1/objects/specimen/import", { key: m.key, body: { csv, dry_run: true } })).status, csv).toBe(403);
    }
    expect((await call("POST", "/v1/objects/specimen/records/bulk_update", { key: m.key, body: { where: { field: "v_address.city", op: "eq", value: "Austin" }, values: { label: "x" } } })).status).toBe(403);
    expect((await call("POST", "/v1/views", { key: m.key, body: { object: "specimen", name: "Peek", sort: [{ field: "v_address.country" }] } })).status).toBe(403);
    // Search text holds the address's parts; a member who can't read them doesn't find records by them.
    const found = await call("GET", "/v1/search?q=austin&objects=specimen", { key: m.key });
    expect(found.status).toBe(200);
    expect(found.json.data.map((x: { id: string }) => x.id)).not.toContain(recA.id);
    expect((await call("GET", "/v1/search?q=austin&objects=specimen", { key: ws.keys.ops })).json.data.map((x: { id: string }) => x.id)).toContain(recA.id);
    const exp = await call("GET", "/v1/objects/specimen/export", { key: m.key });
    expect(exp.status).toBe(200);
    expect(String(exp.json)).not.toMatch(/v_address|v_json|Austin|"c"/);
    const one = (await call("GET", `/v1/objects/specimen/records/${recA.id}`, { key: m.key })).json.data;
    expect(one).not.toHaveProperty("v_address");
    expect(one).not.toHaveProperty("v_json");
    expect((await call("PATCH", `/v1/objects/specimen/records/${recA.id}`, { key: m.key, body: { v_address: { city: "X" } } })).status).toBe(403);
    // A merge can't move the hidden values by choosing them; the survivor keeps its own.
    const dup = await create(ws.keys.ops, "specimen", { label: "dup", v_address: { city: "Hiddenville" } });
    const keep = await create(ws.keys.ops, "specimen", { label: "keep" });
    const merge = await call("POST", "/v1/ops/merge_records", { key: m.key, body: { survivor: keep.id, duplicates: [dup.id], fields: { v_address: dup.id } } });
    expect(merge.status).toBe(403);
    const dry = await call("POST", "/v1/ops/merge_records", { key: m.key, body: { survivor: keep.id, duplicates: [dup.id] } });
    expect(JSON.stringify(dry.json)).not.toContain("Hiddenville");
  });

  it("merges fill a survivor's empty values of every new type from a duplicate, whole", async () => {
    const values = { v_address: { city: "Merged City", country: "IE" }, v_json: { m: [1] }, v_rating: 4, v_percent: 33.3, v_duration: 120 };
    const dup = await create(ws.keys.ops, "specimen", { label: "mdup", ...values });
    const keep = await create(ws.keys.ops, "specimen", { label: "mkeep", v_rating: 2 });
    const dry = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { survivor: keep.id, duplicates: [dup.id] } });
    expect(dry.status, JSON.stringify(dry.json).slice(0, 300)).toBe(200);
    const real = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { survivor: keep.id, duplicates: [dup.id], dry_run: false, confirm_token: dry.json.confirm_token } });
    expect(real.status, JSON.stringify(real.json).slice(0, 300)).toBe(200);
    const after = (await call("GET", `/v1/objects/specimen/records/${keep.id}`, { key: ws.keys.ops })).json.data;
    expect(after).toMatchObject({ v_rating: 2, v_json: { m: [1] }, v_percent: 33.3, v_duration: 120, v_address: { city: "Merged City", country: "IE", display: "Merged City, Ireland" } });
  });

  it("finds duplicates by address ignoring case, and never by json", async () => {
    await create(ws.keys.ops, "specimen", { label: "d1", v_address: { city: "Dupton", country: "GB" } });
    await create(ws.keys.ops, "specimen", { label: "d2", v_address: { city: "DUPTON ", country: "gb" } });
    const r = await call("POST", "/v1/objects/specimen/duplicates", { key: ws.keys.ops, body: { rules: [["v_address"]] } });
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
    expect(r.json.groups.some((g: { records: { label: string }[] }) => g.records.map((x) => x.label).sort().join() === "d1,d2")).toBe(true);
    expect((await call("POST", "/v1/objects/specimen/duplicates", { key: ws.keys.ops, body: { rules: [["v_json"]] } })).status).toBe(422);
  });
});

describe("json numbers, single-line text and filters from the URL", () => {
  const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
  afterAll(() => sql.end());

  it("measures a json value as Postgres stores it, and refuses numbers that expand", async () => {
    // The size is the jsonb text Postgres stores and returns, separators and numbers in full: the same as it counts.
    for (const v of [{ a: 1, b: [1.5, "x", null, true], "ü": { c: 1e-7, d: -0.000123 } }, [0.1, -3, 123456789.123, 1e15, 1.234567890123456e-7], "naïve", 0, { "": [] }]) {
      const [r] = await sql<{ n: number; t: string }[]>`SELECT octet_length(${JSON.stringify(v)}::text::jsonb::text)::int AS n, ${JSON.stringify(v)}::text::jsonb::text AS t`;
      expect(storedJsonBytes(v), r!.t).toBe(r!.n);
    }
    expect(plainDecimal(1e-7)).toBe("0.0000001");
    expect(plainDecimal(-1.5e-10)).toBe("-0.00000000015");
    expect(plainDecimal(123.25)).toBe("123.25");
    const post = (v_json: unknown) => call("POST", "/v1/objects/specimen/records", { key: ws.keys.ops, body: { v_json } });
    for (const bad of [[1e308], [5e-324], { n: 1e16 }, [1e-31]]) expect((await post(bad)).status, JSON.stringify(bad)).toBe(422);
    // 2,000 × 1e-7 is 10 KB as JavaScript writes it and 22 KB as Postgres stores it.
    const tiny = Array.from({ length: 2_000 }, () => 1e-7);
    expect(Buffer.byteLength(JSON.stringify(tiny))).toBeLessThan(16_384);
    expect((await post(tiny)).status).toBe(422);
    expect((await post(tiny.slice(0, 1_000))).status).toBe(201);
    const ordinary = [0.1, 0.30000000000000004, -42, 1234567.891, 1e15, -1e15, 1e-7];
    const ok = await post(ordinary);
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(ok.json.data.v_json).toEqual(ordinary);
    expect((await query(ws.keys.ops, { where: { field: "v_json.a", op: "eq", value: 1e308 } })).status).toBe(422);
  });

  it("refuses C1 controls, line separators and bidi controls in address parts and pack descriptions", async () => {
    for (const city of ["‮SU", "Aus tin", "Aus tin", "x\u0085y", "a⁦b⁩", "‏ok"].slice(0, 5)) {
      const r = await call("POST", "/v1/objects/specimen/records", { key: ws.keys.ops, body: { v_address: { city } } });
      expect(r.status, JSON.stringify(city)).toBe(422);
    }
    // Commas are ordinary: a part holding ", " stays one part, and display is never read back.
    const r = await call("POST", "/v1/objects/specimen/records", { key: ws.keys.ops, body: { v_address: { line1: "Suite 5, Building B", city: "Austin", display: "Elsewhere, ZZ" } } });
    expect(r.status).toBe(201);
    expect(r.json.data.v_address).toMatchObject({ line1: "Suite 5, Building B", city: "Austin", display: "Suite 5, Building B, Austin" });
    expect((await call("POST", "/v1/objects/specimen/import", { key: ws.keys.ops, body: { csv: "label,v_address.display\nX,\"a, b\"\n", dry_run: true } })).status).toBe(422);
    const pack = { manifest: { name: "bidi-pack", version: "1.0.0", parts: ["views"], description: "Safe ‮exe.txt" }, views: [{ name: "x", object: "contact" }] };
    expect((await call("POST", "/v1/packs/plan", { key: ws.keys.admin, body: { pack } })).status).toBe(422);
  });

  it("reads json path values from the URL as JSON scalars when they are ones", async () => {
    expect((await call("POST", "/v1/objects", { key: ws.keys.admin, body: { api_name: "urljson", fields: [{ api_name: "label", type: "text" }, { api_name: "meta", type: "json" }] } })).status).toBe(201);
    const num = await create(ws.keys.ops, "urljson", { label: "number", meta: { n: 1, flag: true, s: "abc", z: null } });
    const txt = await create(ws.keys.ops, "urljson", { label: "text", meta: { n: "1", flag: "true", s: "abc" } });
    const ids = async (qs: string) => (await call("GET", `/v1/objects/urljson/records?${qs}`, { key: ws.keys.ops })).json.data.map((x: { id: string }) => x.id).sort();
    expect(await ids("filter[meta.n]=1")).toEqual([num.id]);
    expect(await ids("filter[meta.flag]=true")).toEqual([num.id]);
    expect(await ids("filter[meta.z]=null")).toEqual([num.id]);
    expect(await ids("filter[meta.s]=abc")).toEqual([num.id, txt.id].sort());
    expect(await ids("filter[meta.n][neq]=1")).toEqual([txt.id]);
    // A body says what it means: the text "1" is text.
    const body = await call("POST", "/v1/query", { key: ws.keys.ops, body: { object: "urljson", where: { field: "meta.n", op: "eq", value: "1" } } });
    expect(body.json.data.map((x: { id: string }) => x.id)).toEqual([txt.id]);
  });

  it("refuses percent precision past 4 decimals, options a type doesn't take, and a display_field that isn't text-like", async () => {
    expect((await call("POST", "/v1/objects/specimen/records", { key: ws.keys.ops, body: { v_percent: 0.00001 } })).status).toBe(422);
    expect((await call("POST", "/v1/objects/specimen/records", { key: ws.keys.ops, body: { v_percent: "12.34567%" } })).status).toBe(422);
    const ok = await call("POST", "/v1/objects/specimen/records", { key: ws.keys.ops, body: { v_percent: 12.3456 } });
    expect(ok.json.data.v_percent).toBe(12.3456);
    // max: 5 equals a rating's default, so it used to pass silently on any field.
    for (const [field, body] of [["v_number", { max: 5 }], ["v_text", { shape: null }], ["v_number", { shape: { type: "object" } }]] as const) {
      expect((await call("PATCH", `/v1/objects/specimen/fields/${field}`, { key: ws.keys.admin, body })).status, `${field} ${JSON.stringify(body)}`).toBe(422);
    }
    for (const type of ["rating", "percent", "date", "number"]) {
      const r = await call("POST", "/v1/objects", { key: ws.keys.admin, body: { api_name: `disp_${type}`, display_field: "f", fields: [{ api_name: "f", type }] } });
      expect(r.status, type).toBe(422);
    }
    expect((await call("POST", "/v1/objects", { key: ws.keys.admin, body: { api_name: "disp_email", display_field: "f", fields: [{ api_name: "f", type: "email" }] } })).status).toBe(201);
  });

  it("names the shared views a retype breaks, asks for confirmation, and keeps a duration's lower bound", async () => {
    expect((await call("POST", "/v1/objects", { key: ws.keys.admin, body: { api_name: "retype_views", fields: [{ api_name: "score", type: "rating" }, { api_name: "spent", type: "duration" }] } })).status).toBe(201);
    expect((await call("POST", "/v1/views", { key: ws.keys.admin, body: { object: "retype_views", name: "By score", shared: true, group_by: [{ field: "score" }] } })).status).toBe(201);
    const doc = (await call("GET", "/v1/schema/export", { key: ws.keys.admin })).json;
    const o = doc.objects.find((x: { name: string }) => x.name === "retype_views");
    for (const f of o.fields) if (f.name === "score" || f.name === "spent") {
      f.type = "number";
      delete f.max;
    }
    const plan = await call("POST", "/v1/schema/plan", { key: ws.keys.admin, body: { document: doc } });
    const score = plan.json.changes.find((c: { change: string; field: string }) => c.change === "field_retyped" && c.field === "score");
    expect(score).toMatchObject({ data_affecting: true, warning: expect.stringContaining('"By score"') });
    expect(score.after.validation).toEqual({ min: 1, max: 5 });
    const headers = { "If-Match": `"${doc.schema_version}"` };
    const refused = await call("POST", "/v1/schema/apply", { key: ws.keys.admin, body: { document: doc }, headers });
    expect(refused.status).toBe(409);
    const ok = await call("POST", "/v1/schema/apply", { key: ws.keys.admin, body: { document: doc, confirm_data_changes: true }, headers });
    expect(ok.status, JSON.stringify(ok.json).slice(0, 300)).toBe(200);
    expect((await call("POST", "/v1/objects/retype_views/records", { key: ws.keys.ops, body: { spent: -1 } })).status).toBe(422);
    expect((await call("POST", "/v1/objects/retype_views/records", { key: ws.keys.ops, body: { score: 9 } })).status).toBe(422);
    expect((await call("POST", "/v1/objects/retype_views/records", { key: ws.keys.ops, body: { spent: 5, score: 3 } })).status).toBe(201);
  });

  it("describes a hidden json field's shape and address parts as it does a hidden select's values: names are not data", async () => {
    const role = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: `noshape_${Date.now()}`, name: "No shape", permissions: ["records:read"],
      fields: { specimen: { v_json: "none", v_address: "none", v_single_select: "none" } } } });
    const m = await memberWithKey(ws, role.json.data.key, ["ops:read"]);
    const fields = (await call("GET", "/v1/objects/specimen", { key: m.key })).json.data.fields;
    const of = (n: string) => fields.find((f: { name: string }) => f.name === n);
    expect(of("v_single_select")).toMatchObject({ access: "none", values: expect.any(Array) });
    expect(of("v_address")).toMatchObject({ access: "none", parts: expect.any(Array) });
    expect(of("v_json")).toMatchObject({ access: "none", path_filters: true });
  });
});

describe("importing part of an address", () => {
  it("merges the part columns a file has into the stored address; an empty cell clears only its own part", async () => {
    const rec = await create(ws.keys.ops, "specimen", { label: "merge-me", v_address: { line1: "1 Main St", city: "Austin", region: "TX", country: "US" } });
    const imp = async (csv: string) => {
      const r = await call("POST", "/v1/objects/specimen/import", { key: ws.keys.ops, body: { csv, key: "id", dry_run: false } });
      expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
      return (await call("GET", `/v1/objects/specimen/records/${rec.id}`, { key: ws.keys.ops })).json.data.v_address;
    };
    expect(await imp(`id,v_address.city
${rec.id},Dallas
`)).toMatchObject({ line1: "1 Main St", city: "Dallas", region: "TX", country: "US" });
    expect(await imp(`id,v_address.city,v_address.region
${rec.id},Houston,
`)).toMatchObject({ line1: "1 Main St", city: "Houston", region: null, country: "US" });
    // Every part cell empty leaves the address as it is, as any empty cell leaves its field.
    expect(await imp(`id,label,v_address.city
${rec.id},renamed,
`)).toMatchObject({ line1: "1 Main St", city: "Houston", country: "US" });
  });
});

describe("views and records with dotted names and __proto__ keys", () => {
  it("a broken view that names a hidden field's part is not described part by part to a reader who can't see the field", async () => {
    expect((await call("POST", "/v1/objects/specimen/fields", { key: ws.keys.admin, body: { api_name: "goner", type: "text" } })).status).toBe(201);
    const v = await call("POST", "/v1/views", { key: ws.keys.admin, body: { object: "specimen", name: "Broken by archive", shared: true,
      where: { and: [{ field: "goner", op: "eq", value: "x" }, { field: "v_address.city", op: "eq", value: "Austin" }] } } });
    expect(v.status, JSON.stringify(v.json)).toBe(201);
    const dry = await call("POST", "/v1/objects/specimen/fields/goner/archive", { key: ws.keys.admin, body: { dry_run: true } });
    expect((await call("POST", "/v1/objects/specimen/fields/goner/archive", { key: ws.keys.admin, body: { dry_run: false, confirm_token: dry.json.confirm_token } })).status).toBe(200);
    const role = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: `noaddr_${Date.now()}`, name: "No address", permissions: ["records:read"],
      fields: { specimen: { v_address: "none" } } } });
    const m = await memberWithKey(ws, role.json.data.key, ["ops:read"]);
    const seen = (await call("GET", `/v1/views/${v.json.data.id}`, { key: m.key })).json.data;
    expect(seen.status).toBe("broken");
    expect(seen.problem).not.toContain("v_address");
    expect(seen.problem).not.toContain("goner");
    // Someone who can read it all is told which field is gone, and only that one.
    const admin = (await call("GET", `/v1/views/${v.json.data.id}`, { key: ws.keys.admin })).json.data;
    expect(admin.problem).toContain('"goner"');
    expect(admin.problem).not.toContain("v_address");
  });

  it("drops __proto__ keys on routes that don't refuse them, harmlessly: nothing reaches a prototype and nothing is skipped", async () => {
    const raw = (path: string, body: string, key = ws.keys.admin) =>
      app.request(path, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body });
    const role = await raw("/v1/roles", `{"key": "proto_${Date.now()}", "name": "P", "permissions": ["records:read"], "objects": {"__proto__": {"read": false}, "specimen": {"write": false}},
      "fields": {"__proto__": {"label": "none"}}}`);
    expect(role.status).toBe(201);
    const made = (await role.json()) as { data: { objects: Record<string, unknown>; fields: Record<string, unknown> } };
    expect(made.data.objects).toEqual({ specimen: { read: null, write: false, archive: null } });
    expect(made.data.fields).toEqual({});
    const rec = await raw("/v1/objects/specimen/records", `{"label": "proto", "__proto__": {"v_rating": 99, "v_text": 5}}`, ws.keys.ops);
    expect(rec.status, await rec.clone().text()).toBe(201);
    const data = ((await rec.json()) as { data: Record<string, unknown> }).data;
    expect(data.v_rating).toBeNull();
    expect((await raw("/v1/objects/specimen/records", `{"label": "proto", "__proto__": {"v_rating": 99}, "v_rating": 99}`, ws.keys.ops)).status).toBe(422);
    // A strict body refuses it outright; inside a filter (free-form until compiled) it is an unknown key the compiler ignores.
    expect((await raw("/v1/views", `{"object": "specimen", "name": "Proto", "shared": true, "__proto__": {"shared": false}}`)).status).toBe(422);
    const view = await raw("/v1/views", `{"object": "specimen", "name": "Proto", "shared": true, "where": {"__proto__": {"field": "v_text"}, "field": "label", "op": "eq", "value": "x"}}`);
    expect(view.status, await view.clone().text()).toBe(201);
    expect(((await view.json()) as { data: { shared: boolean; where: unknown } }).data).toMatchObject({ shared: true, where: { field: "label", op: "eq", value: "x" } });
    expect(({} as Record<string, unknown>).read).toBeUndefined();
    expect(({} as Record<string, unknown>).v_rating).toBeUndefined();
    expect(({} as Record<string, unknown>).field).toBeUndefined();
  });
});
