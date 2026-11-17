import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, type Ctx } from "../src/core/context.js";
import { addField, cachedSchemaToken, loadSchema, updateField } from "../src/core/schema.js";
import { withTenant } from "../src/db/tx.js";
import { WORK_BUDGET_MS } from "../src/lib/errors.js";
import { call, create, memberWithKey, newWorkspace, type Workspace } from "./helpers.js";

type Doc = { schema_version: number; objects: { id?: string; name: string; label?: string; fields?: { id?: string; name: string; [k: string]: unknown }[]; [k: string]: unknown }[];
  pipelines: { id?: string; name: string; stages: { id?: string; name: string; [k: string]: unknown }[]; [k: string]: unknown }[]; [k: string]: unknown };

const pull = async (key: string) => {
  const r = await call("GET", "/v1/schema/export", { key });
  expect(r.status).toBe(200);
  return r.json as Doc;
};
const plan = (key: string, document: unknown, extra: Record<string, unknown> = {}) => call("POST", "/v1/schema/plan", { key, body: { document, ...extra } });
const apply = (key: string, document: unknown, version: number | null, extra: Record<string, unknown> = {}) =>
  call("POST", "/v1/schema/apply", { key, body: { document, ...extra }, headers: version === null ? {} : { "If-Match": `"${version}"` } });

/** Removes everything a workspace assigns itself (IDs, the version), leaving what a document can carry between workspaces. */
function stripIds(doc: unknown): unknown {
  return JSON.parse(JSON.stringify(doc, (k, v) => (k === "id" || k === "schema_version" ? undefined : v)));
}
const obj = (doc: Doc, name: string) => doc.objects.find((o) => o.name === name)!;
const field = (doc: Doc, o: string, f: string) => obj(doc, o).fields!.find((x) => x.name === f);
const clone = <T>(v: T): T => structuredClone(v);

let ws: Workspace;
beforeAll(async () => {
  ws = await newWorkspace("Schemadoc");
  expect((await call("POST", "/v1/objects", { key: ws.keys.admin, body: {
    api_name: "property", label: "Property", plural_label: "Properties", id_prefix: "prop", owned: true,
    fields: [
      { api_name: "address", type: "text", required: true },
      { api_name: "bedrooms", type: "number", validation: { min: 0 } },
      { api_name: "list_price", type: "number" },
      { api_name: "notes", type: "text" },
      { api_name: "state", type: "status", options: { values: [{ key: "listed", label: "Listed" }, { key: "sold", label: "Sold" }], initial: "listed",
        transitions: { listed: ["sold"] } } },
      { api_name: "seller", type: "relation", options: { to: "contact" } },
    ] } })).status).toBe(201);
  expect((await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "tier", type: "single_select",
    options: { values: [{ key: "gold", label: "Gold" }, { key: "silver", label: "Silver" }] } } })).status).toBe(201);
  expect((await call("PATCH", "/v1/objects/contact/fields/email", { key: ws.keys.admin, body: { label: "E-mail" } })).status).toBe(200);
  expect((await call("POST", "/v1/pipelines", { key: ws.keys.admin, body: { name: "Renewals",
    stages: [{ name: "Due", category: "open" }, { name: "Renewed", category: "won" }, { name: "Churned", category: "lost" }] } })).status).toBe(201);
});

describe("schema export", () => {
  it("describes modules, objects with stable IDs, fields and pipelines", async () => {
    const doc = await pull(ws.keys.admin);
    expect(doc.format).toBe("hl-crm-db/schema@1");
    expect(doc.schema_version).toBeGreaterThan(0);
    expect(doc.modules).toEqual(expect.arrayContaining(["core", "sales"]));
    expect(doc.objects[0]!.name).toBe("account");
    const p = obj(doc, "property");
    expect(p.id).toMatch(/^obj_/);
    expect(p.id_prefix).toBe("prop");
    expect(field(doc, "property", "address")).toMatchObject({ id: expect.stringMatching(/^fld_/), type: "text", required: true });
    expect(field(doc, "property", "seller")).toMatchObject({ relation: { to: "contact", cardinality: "many_to_one" } });
    expect(field(doc, "property", "state")).toMatchObject({ initial: "listed", transitions: { listed: ["sold"] } });
    expect(field(doc, "contact", "email")).toMatchObject({ label: "E-mail", standard: true });
    expect(doc.pipelines.find((x) => x.name === "Renewals")!.stages.map((s) => s.name)).toEqual(["Due", "Renewed", "Churned"]);
  });

  it("needs only records:read, while plan and apply need schema:manage", async () => {
    const reader = await memberWithKey(ws, "read_only", ["ops:read"]);
    const doc = await pull(reader.key);
    expect((await plan(reader.key, doc)).status).toBe(403);
    expect((await apply(reader.key, doc, doc.schema_version)).status).toBe(403);
    expect((await plan(ws.keys.ops, doc)).status).toBe(403);
    expect((await apply(ws.keys.ops, doc, doc.schema_version)).status).toBe(403);
  });
});

describe("schema plan and apply", () => {
  it("plans nothing for an unchanged document, and applying it is a no-op", async () => {
    const doc = await pull(ws.keys.admin);
    const p = await plan(ws.keys.admin, doc);
    expect(p.status).toBe(200);
    expect(p.json.changes).toEqual([]);
    expect(p.json.unsupported).toEqual([]);
    expect(p.json.matched_by_name).toEqual([]);
    const a = await apply(ws.keys.admin, doc, doc.schema_version);
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ applied: false, changes: [], schema_version: doc.schema_version });
  });

  it("plans without writing, then applies; applying the same document twice is a no-op", async () => {
    const doc = await pull(ws.keys.admin);
    const edited = clone(doc);
    obj(edited, "property").fields!.push({ name: "garage", type: "boolean", label: "Garage" });
    obj(edited, "property").label = "Listing";
    const p = await plan(ws.keys.admin, edited);
    expect(p.json.changes.map((c: { change: string }) => c.change).sort()).toEqual(["field_added", "object_updated"]);
    expect((await pull(ws.keys.admin)).schema_version).toBe(doc.schema_version);
    expect(field(await pull(ws.keys.admin), "property", "garage")).toBeUndefined();

    const a = await apply(ws.keys.admin, edited, doc.schema_version);
    expect(a.status).toBe(200);
    expect(a.json.applied).toBe(true);
    expect(a.json.schema_version).toBe(doc.schema_version + 2);
    const after = await pull(ws.keys.admin);
    expect(obj(after, "property").label).toBe("Listing");
    expect(field(after, "property", "garage")).toMatchObject({ type: "boolean" });

    const again = await apply(ws.keys.admin, edited, doc.schema_version);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ applied: false, changes: [], schema_version: after.schema_version });
  });

  it("plans a changed name with the same ID as a rename, not a delete and an add", async () => {
    const doc = await pull(ws.keys.admin);
    const edited = clone(doc);
    field(edited, "property", "notes")!.name = "remarks";
    const p = await plan(ws.keys.admin, edited);
    expect(p.json.changes).toEqual([expect.objectContaining({ change: "field_updated", field: "notes",
      before: { api_name: "notes" }, after: { api_name: "remarks" }, warning: expect.stringContaining("remarks") })]);
    const a = await apply(ws.keys.admin, edited, doc.schema_version);
    expect(a.status).toBe(200);
    const after = await pull(ws.keys.admin);
    expect(field(after, "property", "remarks")!.id).toBe(field(doc, "property", "notes")!.id);
    expect(field(after, "property", "notes")).toBeUndefined();
  });

  it("matches a hand-written document without IDs by name, and says so", async () => {
    const doc = { objects: [{ name: "property", fields: [{ name: "address", type: "text", description: "Street address" }] }] };
    const p = await plan(ws.keys.admin, doc);
    expect(p.status).toBe(200);
    expect(p.json.matched_by_name).toEqual(expect.arrayContaining([
      { path: "objects.property", reason: "no id in the document" },
      { path: "objects.property.fields.address", reason: "no id in the document" },
    ]));
    expect(p.json.changes).toEqual([expect.objectContaining({ change: "field_updated", field: "address", after: { description: "Street address" } })]);
    // Leaving fields out of an entry keeps them; it never archives without prune.
    expect(p.json.notes.some((n: string) => n.startsWith("objects.property.fields.bedrooms"))).toBe(true);
    expect(p.json.changes.some((c: { change: string }) => c.change === "field_archived")).toBe(false);
  });

  it("refuses to overwrite changes made since the document's version, unless drift is accepted", async () => {
    const doc = await pull(ws.keys.admin);
    // Someone relabels a field through the API after the pull…
    expect((await call("PATCH", "/v1/objects/property/fields/bedrooms", { key: ws.keys.admin, body: { label: "Beds" } })).status).toBe(200);
    // …and someone else changes an unrelated field.
    expect((await call("PATCH", "/v1/objects/property/fields/list_price", { key: ws.keys.admin, body: { description: "Asking price" } })).status).toBe(200);
    const edited = clone(doc);
    field(edited, "property", "address")!.label = "Street";
    // The stale document still has the old label on bedrooms, so applying it would undo the relabel.
    field(edited, "property", "list_price")!.description = "Asking price";
    const p = await plan(ws.keys.admin, edited);
    expect(p.json.drift).toEqual(expect.arrayContaining([
      expect.objectContaining({ change: "field_updated", object: "property", field: "bedrooms", conflicts: true, actor: expect.stringMatching(/^usr_/) }),
      expect.objectContaining({ field: "list_price", conflicts: false }),
    ]));
    const refused = await apply(ws.keys.admin, edited, doc.schema_version);
    expect(refused.status).toBe(412);
    expect(refused.json.code).toBe("schema_drift");
    expect(refused.json.errors).toEqual([expect.objectContaining({ field: "bedrooms" })]);
    expect(field(await pull(ws.keys.admin), "property", "address")!.label).toBe("Address");

    const accepted = await apply(ws.keys.admin, edited, doc.schema_version, { accept_drift: true });
    expect(accepted.status).toBe(200);
    const after = await pull(ws.keys.admin);
    expect(field(after, "property", "bedrooms")!.label).toBe("Bedrooms");
    expect(field(after, "property", "address")!.label).toBe("Street");
  });

  it("does not block on drift the plan does not touch", async () => {
    const doc = await pull(ws.keys.admin);
    expect((await call("PATCH", "/v1/objects/contact/fields/tier", { key: ws.keys.admin, body: { label: "Tier level" } })).status).toBe(200);
    const edited = clone(doc);
    field(edited, "contact", "tier")!.label = "Tier level"; // agrees with the drift, so nothing to change there
    obj(edited, "property").description = "A home for sale";
    const a = await apply(ws.keys.admin, edited, doc.schema_version);
    expect(a.status).toBe(200);
    expect(a.json.drift).toEqual([expect.objectContaining({ field: "tier", conflicts: false })]);
  });

  it("needs If-Match (or accept_drift) when there are changes", async () => {
    const doc = await pull(ws.keys.admin);
    obj(doc, "property").description = "Changed without If-Match";
    const r = await apply(ws.keys.admin, doc, null);
    expect(r.status).toBe(428);
    expect(r.json.code).toBe("if_match_required");
  });

  it("archives fields missing from the document only with prune, and only with confirmation", async () => {
    const doc = await pull(ws.keys.admin);
    const property = await create(ws.keys.ops, "property", { address: "1 Main St", list_price: 10 });
    expect(property.id).toMatch(/^prop_/);
    const edited = clone(doc);
    obj(edited, "property").fields = obj(edited, "property").fields!.filter((f) => f.name !== "list_price");
    expect((await plan(ws.keys.admin, edited)).json.changes).toEqual([]);
    const pruned = await plan(ws.keys.admin, edited, { prune: true });
    expect(pruned.json.changes).toEqual([expect.objectContaining({ change: "field_archived", field: "list_price", data_affecting: true,
      warning: expect.stringContaining("1 record(s)") })]);
    const noPrune = await apply(ws.keys.admin, edited, doc.schema_version);
    expect(noPrune.json.applied).toBe(false);
    const unconfirmed = await apply(ws.keys.admin, edited, doc.schema_version, { prune: true });
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.json.code).toBe("confirmation_required");
    const done = await apply(ws.keys.admin, edited, doc.schema_version, { prune: true, confirm_data_changes: true });
    expect(done.status).toBe(200);
    expect(field(await pull(ws.keys.admin), "property", "list_price")).toBeUndefined();
  });

  it("retypes along a safe path, converting stored values, and refuses unsafe ones", async () => {
    const doc = await pull(ws.keys.admin);
    const rec = await create(ws.keys.ops, "property", { address: "2 Main St", bedrooms: 3 });
    const edited = clone(doc);
    field(edited, "property", "bedrooms")!.type = "currency";
    const p = await plan(ws.keys.admin, edited);
    expect(p.json.changes).toEqual([expect.objectContaining({ change: "field_retyped", data_affecting: true, before: { type: "number" }, after: { type: "currency" } })]);
    expect((await apply(ws.keys.admin, edited, doc.schema_version, { confirm_data_changes: true })).status).toBe(200);
    const read = await call("GET", `/v1/objects/property/records/${rec.id}`, { key: ws.keys.ops });
    expect(read.json.data.bedrooms).toBe(3);

    const bad = clone(await pull(ws.keys.admin));
    field(bad, "property", "address")!.type = "number";
    const r = await plan(ws.keys.admin, bad);
    expect(r.json.unsupported).toEqual([expect.objectContaining({ path: "objects.property.fields.address.type" })]);
    const refused = await apply(ws.keys.admin, bad, bad.schema_version);
    expect(refused.status).toBe(422);
    expect(refused.json.code).toBe("schema_unsupported");
  });

  it("retypes text → long_text and single_select → multi_select, keeping values, search text and the history consistent", async () => {
    expect((await call("POST", "/v1/objects/property/fields", { key: ws.keys.admin, body: { api_name: "summary", type: "text" } })).status).toBe(201);
    expect((await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "grade", type: "single_select",
      options: { values: [{ key: "a", label: "A" }, { key: "b", label: "B" }] } } })).status).toBe(201);
    const word = `zq${Date.now().toString(36)}summaryword`;
    const rec = await create(ws.keys.ops, "property", { address: "3 Main St", summary: `Has ${word}` });
    const graded = await create(ws.keys.ops, "contact", { email: `grade-${Date.now()}@example.com`, grade: "a" });
    const found = async () => (await call("GET", `/v1/search?q=${word}`, { key: ws.keys.ops })).json.data.map((x: { id: string }) => x.id);
    expect(await found()).toContain(rec.id);
    const doc = await pull(ws.keys.admin);
    const edited = clone(doc);
    field(edited, "property", "summary")!.type = "long_text";
    field(edited, "contact", "grade")!.type = "multi_select";
    const p = await plan(ws.keys.admin, edited);
    expect(p.json.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ change: "field_retyped", field: "summary", before: { type: "text" }, after: { type: "long_text" } }),
      expect.objectContaining({ change: "field_retyped", field: "grade", data_affecting: true, warning: expect.stringContaining("1 stored value(s)") }),
    ]));
    expect(p.json.changes.find((c: { field: string }) => c.field === "summary").data_affecting).toBeUndefined();
    expect((await apply(ws.keys.admin, edited, doc.schema_version)).json.code).toBe("confirmation_required"); // grade converts values
    const a = await apply(ws.keys.admin, edited, doc.schema_version, { confirm_data_changes: true });
    expect(a.status).toBe(200);
    expect((await call("GET", `/v1/objects/property/records/${rec.id}`, { key: ws.keys.ops })).json.data.summary).toBe(`Has ${word}`);
    expect((await call("GET", `/v1/objects/contact/records/${graded.id}`, { key: ws.keys.ops })).json.data.grade).toEqual(["a"]);
    // long_text isn't in search_text, so the records already stored stop matching on it, as new ones would.
    expect(await found()).not.toContain(rec.id);
    expect(await found()).toEqual([]);
    expect((await call("GET", "/v1/search?q=3 main st", { key: ws.keys.ops })).json.data.map((x: { id: string }) => x.id)).toContain(rec.id);
    const changes = (await call("GET", "/v1/schema/changes?limit=10", { key: ws.keys.admin })).json.data as { change: string; field: string; before: unknown; after: unknown }[];
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ change: "field_retyped", field: "summary", before: { type: "text" }, after: { type: "long_text" } }),
      expect.objectContaining({ change: "field_retyped", field: "grade", before: { type: "single_select" }, after: { type: "multi_select" } }),
    ]));
    const log = (await call("GET", "/v1/audit-log?action=schema.field_retyped", { key: ws.keys.admin })).json.data as { details: { field: string } }[];
    expect(log.map((e) => e.details.field)).toEqual(expect.arrayContaining(["summary", "grade", "bedrooms"]));
  });

  it("retypes a restricted field only where no stored value is rewritten, and never a unique one", async () => {
    for (const [api_name, type, extra] of [["vault_note", "text", {}], ["vault_num", "number", {}], ["ref_code", "text", { unique: true }]] as const) {
      expect((await call("POST", "/v1/objects/property/fields", { key: ws.keys.admin, body: { api_name, type, ...(extra as object),
        ...(api_name.startsWith("vault") ? { sensitivity: "restricted" } : {}) } })).status).toBe(201);
    }
    const rec = await create(ws.keys.admin, "property", { address: "4 Main St", vault_note: "sealed note", vault_num: 7, ref_code: `R${Date.now()}` });
    const retype = async (name: string, type: string) => {
      const doc = await pull(ws.keys.admin);
      field(doc, "property", name)!.type = type;
      return apply(ws.keys.admin, doc, doc.schema_version, { confirm_data_changes: true });
    };
    const num = await retype("vault_num", "currency");
    expect(num.status).toBe(422);
    expect(num.json.detail).toMatch(/Restricted values are encrypted/);
    const unique = await retype("ref_code", "long_text");
    expect(unique.status).toBe(422);
    expect(unique.json.detail).toMatch(/is unique/);
    expect((await retype("vault_note", "long_text")).status).toBe(200);
    const after = (await call("GET", `/v1/objects/property/records/${rec.id}`, { key: ws.keys.admin })).json.data;
    expect(after).toMatchObject({ vault_note: "sealed note", vault_num: 7 });
    expect((await call("GET", `/v1/objects/property/records/${rec.id}`, { key: ws.keys.ops })).json.data.vault_note).toBe("[restricted]");
    expect(field(await pull(ws.keys.admin), "property", "vault_num")).toMatchObject({ type: "number", sensitivity: "restricted" });
  });

  it("reports what it cannot do: renaming an object, changing a relation target", async () => {
    const doc = await pull(ws.keys.admin);
    obj(doc, "property").name = "listing";
    const r = await plan(ws.keys.admin, doc);
    expect(r.json.unsupported).toEqual([expect.objectContaining({ path: "objects.listing", message: expect.stringContaining("cannot be renamed") })]);
  });

  it("renames, adds and reorders pipeline stages by ID", async () => {
    const doc = await pull(ws.keys.admin);
    const edited = clone(doc);
    const renewals = edited.pipelines.find((x) => x.name === "Renewals")!;
    renewals.stages[0]!.name = "Up for renewal";
    renewals.stages.splice(1, 0, { name: "Negotiating", category: "open", probability: 50 });
    const a = await apply(ws.keys.admin, edited, doc.schema_version);
    expect(a.status).toBe(200);
    expect(a.json.changes.map((c: { change: string }) => c.change)).toEqual(["stage_updated", "stage_added", "stages_reordered"]);
    const after = (await pull(ws.keys.admin)).pipelines.find((x) => x.name === "Renewals")!;
    expect(after.stages.map((s) => s.name)).toEqual(["Up for renewal", "Negotiating", "Renewed", "Churned"]);
    expect(after.stages[0]!.id).toBe(renewals.stages[0]!.id);
    expect((await apply(ws.keys.admin, edited, doc.schema_version)).json.applied).toBe(false);
  });

  it("round trip: export, apply to a fresh workspace, export again: equal apart from IDs", async () => {
    const source = await pull(ws.keys.admin);
    // A second custom object related to the first, to exercise ordering of new objects.
    const withRelation = clone(source);
    withRelation.objects.push({ name: "viewing", label: "Viewing", plural_label: "Viewings", id_prefix: "view", owned: false,
      fields: [{ name: "when", type: "datetime", label: "When" }, { name: "property", type: "relation", label: "Property", relation: { to: "property", cardinality: "many_to_one" } }] });
    withRelation.objects.reverse(); // new objects before their relation targets in the file
    expect((await apply(ws.keys.admin, withRelation, source.schema_version)).status).toBe(200);
    const full = await pull(ws.keys.admin);

    const fresh = await newWorkspace("Schemadoc target");
    const r = await apply(fresh.keys.admin, full, null, { accept_drift: true });
    expect(r.status).toBe(200);
    expect(r.json.matched_by_name.length).toBeGreaterThan(0);
    const copied = await pull(fresh.keys.admin);
    expect(stripIds(copied)).toEqual(stripIds(full));
    // And the copy is stable: planning the source document against it changes nothing.
    expect((await plan(fresh.keys.admin, full)).json.changes).toEqual([]);
  });

  it("rejects malformed documents", async () => {
    expect((await plan(ws.keys.admin, { objects: [{ name: "property", fields: [{ name: "x", type: "text", requird: true }] }] })).status).toBe(422);
    expect((await plan(ws.keys.admin, { format: "other/1" })).status).toBe(422);
    const dup = await plan(ws.keys.admin, { objects: [{ name: "property" }, { name: "property" }] });
    expect(dup.status).toBe(422);
  });

  it("logs each change and the apply itself in the audit log", async () => {
    const log = await call("GET", "/v1/audit-log?action=schema.applied", { key: ws.keys.admin });
    expect(log.json.data.length).toBeGreaterThan(0);
    expect(log.json.data[0].details).toMatchObject({ prune: expect.any(Boolean), changes: expect.any(Number) });
  });
});

/** A change made in a transaction the test controls: it commits (or rolls back) only when told to. */
function held(tenantId: string, fn: (tx: Parameters<Parameters<typeof withTenant>[1]>[0], ctx: Ctx) => Promise<unknown>) {
  const ctx: Ctx = { tenantId, actor: { type: "system", id: null, role: "owner" }, keyId: null, permissions: new Set(ALL_PERMISSIONS),
    scopes: new Set(), surface: "system", requestId: "held" };
  let release!: (commit: boolean) => void;
  const gate = new Promise<boolean>((r) => (release = r));
  let ready!: () => void;
  const started = new Promise<void>((r) => (ready = r));
  const done = withTenant(tenantId, async (tx) => {
    await fn(tx, ctx);
    ready();
    if (!(await gate)) throw new Error("rolled back on purpose");
  }).catch((e: Error) => {
    if (e.message !== "rolled back on purpose") throw e;
  });
  return { started, done, finish: async (commit = true) => { release(commit); await done; } };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("schema changes made concurrently", () => {
  let w: Workspace;
  beforeAll(async () => {
    w = await newWorkspace("Schemadoc race");
    expect((await call("POST", "/v1/objects", { key: w.keys.admin, body: { api_name: "unit", fields: [
      { api_name: "code", type: "text" }, { api_name: "rooms", type: "number" }, { api_name: "memo", type: "text" }] } })).status).toBe(201);
  });
  afterEach(() => {
    WORK_BUDGET_MS.schema = 20_000;
  });

  it("apply waits for a schema change in flight, then reports it as drift (412) instead of overwriting it", async () => {
    const doc = await pull(w.keys.admin);
    const a = held(w.tenantId, (tx, ctx) => updateField(tx, ctx, "unit", "rooms", { label: "Rooms (A)" }, false));
    await a.started;
    const edited = clone(doc);
    field(edited, "unit", "rooms")!.label = "Rooms (B)";
    const b = apply(w.keys.admin, edited, doc.schema_version);
    await sleep(300); // b is waiting for the schema lock
    await a.finish();
    const res = await b;
    expect(res.status).toBe(412);
    expect(res.json.code).toBe("schema_drift");
    expect(res.json.errors).toEqual([expect.objectContaining({ change: "field_updated", field: "rooms", conflicts: true })]);
    expect(field(await pull(w.keys.admin), "unit", "rooms")!.label).toBe("Rooms (A)");
  });

  it("serialises every schema writer: a second add of the same field waits and gets a clean 409", async () => {
    const a = held(w.tenantId, (tx, ctx) => addField(tx, ctx, "unit", { api_name: "floor", type: "number" }, false));
    await a.started;
    const b = call("POST", "/v1/objects/unit/fields", { key: w.keys.admin, body: { api_name: "floor", type: "text" } });
    await sleep(300);
    await a.finish();
    const res = await b;
    expect(res.status).toBe(409);
    expect(res.json.detail).toMatch(/already exists/);
  });

  it("treats re-adding a field archived since the document's version as a conflict", async () => {
    const doc = await pull(w.keys.admin);
    const dry = await call("POST", "/v1/objects/unit/fields/memo/archive", { key: w.keys.admin, body: { dry_run: true } });
    expect((await call("POST", "/v1/objects/unit/fields/memo/archive", { key: w.keys.admin, body: { confirm_token: dry.json.confirm_token } })).status).toBe(200);
    // The stale document still lists memo (under its old ID), so applying it would bring the field back.
    const p = await plan(w.keys.admin, doc);
    expect(p.json.changes).toEqual([expect.objectContaining({ change: "field_added", field: "memo" })]);
    expect(p.json.drift).toEqual([expect.objectContaining({ change: "field_archived", field: "memo", conflicts: true })]);
    const refused = await apply(w.keys.admin, doc, doc.schema_version);
    expect(refused.status).toBe(412);
    expect(field(await pull(w.keys.admin), "unit", "memo")).toBeUndefined();
  });

  it("treats adding a name renamed since the document's version as a conflict, for fields, pipelines and stages", async () => {
    expect((await call("POST", "/v1/pipelines", { key: w.keys.admin, body: { name: "Lettings",
      stages: [{ name: "Open", category: "open" }, { name: "Let", category: "won" }, { name: "Lost", category: "lost" }] } })).status).toBe(201);
    const version = (await pull(w.keys.admin)).schema_version;
    const lettings = (await pull(w.keys.admin)).pipelines.find((p) => p.name === "Lettings")!;
    expect((await call("PATCH", "/v1/objects/unit/fields/code", { key: w.keys.admin, body: { api_name: "ref" } })).status).toBe(200);
    // The schema-as-code route renames pipelines and stages; a document with IDs does it here.
    const renamed = await pull(w.keys.admin);
    const r = renamed.pipelines.find((p) => p.name === "Lettings")!;
    r.name = "Rentals";
    r.stages[0]!.name = "Viewing";
    expect((await apply(w.keys.admin, renamed, renamed.schema_version)).status).toBe(200);
    // A hand-written document from before, without IDs, still uses the old names: each would be added again.
    const handWritten = { schema_version: version, objects: [{ name: "unit", fields: [{ name: "code", type: "text" }] }],
      pipelines: [{ name: "Rentals", stages: [...lettings.stages.map(({ id: _id, ...s }) => s)] }] };
    const p = await plan(w.keys.admin, handWritten);
    expect(p.json.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ change: "field_added", field: "code" }),
      expect.objectContaining({ change: "stage_added" }),
    ]));
    expect(p.json.drift).toEqual(expect.arrayContaining([
      expect.objectContaining({ change: "field_updated", field: "ref", conflicts: true }),
      expect.objectContaining({ change: "stage_updated", conflicts: true }),
    ]));
    const pipelinePlan = await plan(w.keys.admin, { schema_version: version, pipelines: [{ name: "Lettings", stages: lettings.stages.map(({ id: _id, ...s }) => s) }] });
    expect(pipelinePlan.json.drift).toEqual(expect.arrayContaining([expect.objectContaining({ change: "pipeline_updated", conflicts: true })]));
    expect((await apply(w.keys.admin, handWritten, version)).status).toBe(412);
  });

  it("refuses an If-Match newer than the workspace, and treats such a document version as unknown drift", async () => {
    const doc = await pull(w.keys.admin);
    obj(doc, "unit").description = "From the future";
    const r = await apply(w.keys.admin, doc, doc.schema_version + 10);
    expect(r.status).toBe(412);
    expect(r.json.code).toBe("schema_version_ahead");
    const p = await plan(w.keys.admin, { ...doc, schema_version: doc.schema_version + 10 });
    expect(p.json).toMatchObject({ drift: [], drift_truncated: true });
    expect(p.json.notes.join(" ")).toMatch(/newer than this workspace/);
  });

  it("gives plan and apply a time budget, and caps the changes one document makes", async () => {
    const doc = await pull(w.keys.admin);
    obj(doc, "unit").description = "Slow";
    WORK_BUDGET_MS.schema = 0;
    const slow = await apply(w.keys.admin, doc, doc.schema_version);
    expect(slow.status).toBe(503);
    expect(slow.json.code).toBe("work_budget_exceeded");
    expect((await plan(w.keys.admin, doc)).status).toBe(503);
    WORK_BUDGET_MS.schema = 20_000;
    expect(obj(await pull(w.keys.admin), "unit").description).not.toBe("Slow");

    const big = clone(doc);
    for (const n of ["bulk_a", "bulk_b", "bulk_c"]) {
      big.objects.push({ name: n, fields: Array.from({ length: 170 }, (_, i) => ({ name: `f${i}`, type: "text" })) });
    }
    const r = await plan(w.keys.admin, big);
    expect(r.status).toBe(422);
    expect(r.json.detail).toMatch(/more than 500 changes/);
  });

  it("never serves a schema from a transaction that rolled back, even once the version number comes round again", async () => {
    let phantom = "";
    const a = held(w.tenantId, async (tx, ctx) => {
      await addField(tx, ctx, "unit", { api_name: "phantom", type: "text" }, false);
      const schema = await loadSchema(tx);
      expect(schema.objects.get("unit")!.byName.has("phantom")).toBe(true);
      phantom = schema.token;
    });
    await a.started;
    await a.finish(false);
    // The uncommitted schema stayed with its transaction: the process-wide cache never held it.
    expect(cachedSchemaToken(w.tenantId)).not.toBe(phantom);
    // Another process makes a schema change, which takes the version number the rolled-back change had.
    await withTenant(w.tenantId, async (tx) => tx`UPDATE tenants SET schema_version = schema_version + 1`);
    const r = await call("POST", "/v1/objects/unit/records", { key: w.keys.ops, body: { phantom: "boo" } });
    expect(r.status).toBe(422);
    expect((await call("GET", "/v1/objects/unit", { key: w.keys.admin })).json.data.fields.map((f: { name: string }) => f.name)).not.toContain("phantom");
  });

  it("leaves the objects of a module that is off out of the export, and apply with prune leaves them alone", async () => {
    const m = await newWorkspace("Schemadoc modules");
    expect((await call("PATCH", "/v1/workspace/modules", { key: m.keys.admin, body: { modules: ["core"] } })).status).toBe(200);
    const doc = await pull(m.keys.admin);
    expect(doc.objects.map((o) => o.name)).not.toEqual(expect.arrayContaining(["deal"]));
    expect(doc.objects.some((o) => o.module === "sales")).toBe(false);
    obj(doc, "contact").description = "People";
    const pruned = await plan(m.keys.admin, doc, { prune: true });
    expect(pruned.json.unsupported).toEqual([]);
    expect(pruned.json.changes).toEqual([expect.objectContaining({ change: "object_updated" })]);
    expect((await apply(m.keys.admin, doc, doc.schema_version, { prune: true })).status).toBe(200);
    expect((await call("PATCH", "/v1/workspace/modules", { key: m.keys.admin, body: { modules: ["core", "sales"] } })).status).toBe(200);
    expect(obj(await pull(m.keys.admin), "deal").fields!.length).toBeGreaterThan(0);
  });
});
