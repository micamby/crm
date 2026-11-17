import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HEAVY_LIMITS, resetRateLimiter } from "../src/api/app.js";
import { credential, type Ctx } from "../src/core/context.js";
import { FUZZY_LIMITS } from "../src/core/duplicates.js";
import { MERGE_MAX_REFERENCES, REFERENCES } from "../src/core/merge.js";
import { WORK_BUDGET_MS } from "../src/lib/errors.js";
import { decodeId } from "../src/lib/ids.js";
import { pruneHistory } from "../src/worker/events.js";
import { call, create, memberWithKey, newWorkspace, uniqueEmail, type Workspace } from "./helpers.js";

/**
 * Guards on the write-side features: the heavy-request gate and what heavy work is charged, the fuzzy
 * duplicate finder's bounds, single-use confirm tokens, merge confirmation, bounds and reference
 * handling, and the database rules a merge relies on.
 */

const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 4, onnotice: () => {} });
afterAll(() => sql.end());

const stamp = Date.now().toString(36);
let ws: Workspace;
let other: Workspace;
let n = 0;
const ALL = ["records:read", "records:write", "records:archive"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (id: string, key = ws.keys.ops) => (await call("GET", `/v1/records/${id}`, { key })).json.data;
const uuid = (id: string) => decodeId(id)!.uuid;
const asApp = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>, tenant = ws.tenantId) => sql.begin(async (tx) => {
  await tx`SELECT set_config('app.tenant_id', ${tenant}, true)`;
  return fn(tx);
}) as Promise<T>;

async function member(permissions: string[] = ALL, rules: Record<string, unknown> = {}) {
  const r = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: `g${++n}_${stamp}`, name: "Guards", permissions, ...rules } });
  if (r.status !== 201) throw new Error(`role failed: ${r.status} ${JSON.stringify(r.json)}`);
  return memberWithKey(ws, r.json.data.key, ["ops:read", "ops:write"]);
}

async function merge(body: Record<string, unknown>, key = ws.keys.ops) {
  const dry = await call("POST", "/v1/ops/merge_records", { key, body: { ...body, dry_run: true } });
  if (dry.status !== 200) return dry;
  return call("POST", "/v1/ops/merge_records", { key, body: { ...body, dry_run: false, confirm_token: dry.json.confirm_token } });
}

/** Holds a row lock on a contact for `ms`, as another writer would; resolves once the lock is taken, with a promise for its release (wrapped: a bare promise would be awaited too). */
async function holdContact(id: string, ms: number): Promise<{ released: Promise<void> }> {
  let taken!: () => void;
  const ready = new Promise<void>((r) => { taken = r; });
  const done = asApp(async (tx) => {
    await tx`SELECT 1 FROM contacts WHERE id = ${uuid(id)} FOR UPDATE`;
    taken();
    await sleep(ms);
  });
  await ready;
  return { released: done };
}

beforeAll(async () => {
  ws = await newWorkspace("Write guards");
  other = await newWorkspace("Write guards other");
});

afterEach(() => {
  // Merges and previews here are charged by size; each test starts with full buckets.
  resetRateLimiter();
  HEAVY_LIMITS.perCredential = 2;
  HEAVY_LIMITS.server = 5;
  FUZZY_LIMITS.timeoutMs = 1_500;
  WORK_BUDGET_MS.merge = 20_000;
});

describe("heavy-request gate", () => {
  it("is keyed on a credential that always exists: the key, else the member, else the workspace", () => {
    const base = { tenantId: "t1", keyId: null, actor: { type: "user", id: "u1", role: "member" } } as unknown as Ctx;
    expect(credential({ ...base, keyId: "k1" })).toBe("key:k1");
    expect(credential(base)).toBe("user:t1:u1");
    expect(credential({ ...base, actor: { type: "system", id: null, role: "owner" } })).toBe("system@t1");
  });

  it("allows two heavy requests at once per key, refuses a third at once with 429, and ordinary requests stay fast", async () => {
    const m = await member();
    const c = await create(ws.keys.ops, "contact", { email: uniqueEmail("gate") });
    const { released } = await holdContact(c.id, 1_500);
    const heavy = () => call("POST", "/v1/objects/contact/records/bulk_archive", { key: m.key, body: { ids: [c.id] } });
    const first = [heavy(), heavy()];
    await sleep(200);
    const started = Date.now();
    const third = await heavy();
    expect(Date.now() - started).toBeLessThan(500);
    expect(third.status).toBe(429);
    expect(third.json.code).toBe("too_many_heavy_requests");
    expect(third.headers.get("retry-after")).toBe("1");
    // The same key's ordinary requests, and another workspace's, go through meanwhile.
    const t0 = Date.now();
    expect((await call("GET", `/v1/records/${c.id}`, { key: m.key })).status).toBe(200);
    expect((await call("GET", "/v1/objects/contact/records?limit=1", { key: other.keys.ops })).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(500);
    await released;
    expect((await Promise.all(first)).map((r) => r.status)).toEqual([200, 200]);
    // The slots were given back.
    expect((await heavy()).status).toBe(200);
  });

  it("has a server-wide ceiling below the pool size, across credentials", async () => {
    expect(HEAVY_LIMITS.server).toBeLessThan(10);
    HEAVY_LIMITS.server = 2;
    const [a, b, z] = [await member(), await member(), await member()];
    const c = await create(ws.keys.ops, "contact", { email: uniqueEmail("ceil") });
    const { released } = await holdContact(c.id, 1_500);
    const heavy = (key: string) => call("POST", "/v1/objects/contact/records/bulk_archive", { key, body: { ids: [c.id] } });
    const running = [heavy(a.key), heavy(b.key)];
    await sleep(200);
    const refused = await heavy(z.key);
    expect(refused.status).toBe(429);
    expect((await call("GET", "/v1/objects/contact/records?limit=1", { key: z.key })).status).toBe(200);
    await released;
    expect((await Promise.all(running)).map((r) => r.status)).toEqual([200, 200]);
  });
});

describe("fuzzy duplicates", () => {
  let fz: Workspace;
  beforeAll(async () => {
    fz = await newWorkspace("Fuzzy probe");
    // The probe: 500 contacts with ~600-character names that share most of their trigrams.
    const filler = "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(6);
    await asApp((tx) => tx`INSERT INTO contacts (tenant_id, id, first_name, last_name)
      SELECT ${fz.tenantId}, gen_random_uuid(), 'Name ' || g || ' ' || ${filler}, md5(g::text) || ${filler} FROM generate_series(1, 500) g`, fz.tenantId);
  });

  it("long names: finishes well under a second (names are compared by a bounded prefix), or is refused quickly with a hint", async () => {
    const started = Date.now();
    const res = await call("POST", "/v1/objects/contact/duplicates", { key: fz.keys.ops, body: { fuzzy: true, min_similarity: 0.3 } });
    const ms = Date.now() - started;
    expect([200, 422]).toContain(res.status);
    // Bounded well below the 5 s statement timeout it used to hit; the margin allows for a slow CI machine.
    expect(ms).toBeLessThan(3_000);
    // Past its own timeout it is a 422 with a hint, not a 503, and the request's transaction is still usable.
    FUZZY_LIMITS.timeoutMs = 1;
    const slow = await call("POST", "/v1/objects/contact/duplicates", { key: fz.keys.ops, body: { fuzzy: true, min_similarity: 0.3 } });
    expect(slow.status).toBe(422);
    expect(slow.json.code).toBe("too_slow");
    expect(slow.json.detail).toMatch(/min_similarity/);
  });

  it("concurrent fuzzy requests beyond the gate get 429 while an unrelated request stays fast", async () => {
    const all = Array.from({ length: 6 }, () => call("POST", "/v1/objects/contact/duplicates", { key: fz.keys.ops, body: { fuzzy: true, min_similarity: 0.3 } }));
    const t0 = Date.now();
    expect((await call("GET", "/v1/objects/contact/records?limit=1", { key: other.keys.ops })).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2_500);
    const statuses = (await Promise.all(all)).map((r) => r.status);
    expect(statuses.every((s) => s === 200 || s === 429 || s === 422)).toBe(true);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});

describe("confirm tokens", () => {
  it("bulk: a token applies once; a replay after a restore is refused with 409", async () => {
    const tag = `rp${stamp}`;
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) ids.push((await create(ws.keys.ops, "contact", { email: uniqueEmail(`rp${i}`), source: tag })).id);
    const where = { field: "source", op: "eq", value: tag };
    const dry = await call("POST", "/v1/objects/contact/records/bulk_archive", { key: ws.keys.ops, body: { where } });
    const body = { where, dry_run: false, confirm_token: dry.json.confirm_token };
    expect((await call("POST", "/v1/objects/contact/records/bulk_archive", { key: ws.keys.ops, body })).status).toBe(200);
    expect((await call("POST", `/v1/objects/contact/records/${ids[0]}/restore`, { key: ws.keys.ops })).status).toBe(200);
    const replay = await call("POST", "/v1/objects/contact/records/bulk_archive", { key: ws.keys.ops, body });
    expect(replay.status).toBe(409);
    expect(replay.json.code).toBe("confirm_token_used");
    expect((await get(ids[0]!)).archived_at).toBeUndefined();
    // Spent tokens are dropped by the retention pass once they have expired.
    await asApp((tx) => tx`INSERT INTO confirm_tokens (tenant_id, token_hash, expires_at) VALUES (${ws.tenantId}, ${Buffer.from(`old${stamp}`)}, now() - interval '1 minute')`);
    await pruneHistory(ws.tenantId);
    const left = await asApp((tx) => tx<{ n: number }[]>`SELECT count(*)::int AS n FROM confirm_tokens WHERE expires_at < now()`);
    expect(left[0]!.n).toBe(0);
  });

  it("bulk by ids: above 25 records a run needs the token of a dry run of the same ids", async () => {
    const tag = `ids${stamp}`;
    await asApp((tx) => tx`INSERT INTO contacts (tenant_id, id, first_name, source) SELECT ${ws.tenantId}, gen_random_uuid(), 'Ids', ${tag} FROM generate_series(1, 27)`);
    const q = await call("POST", "/v1/query", { key: ws.keys.ops, body: { object: "contact", where: { field: "source", op: "eq", value: tag }, limit: 100 } });
    const ids = q.json.data.map((r: { id: string }) => r.id) as string[];
    const path = "/v1/objects/contact/records/bulk_update";
    const values = { job_title: "Many" };
    const no = await call("POST", path, { key: ws.keys.ops, body: { ids: ids.slice(0, 26), values, dry_run: false } });
    expect(no.status).toBe(400);
    expect(no.json.detail).toMatch(/more than 25 records needs confirmation/);
    expect((await call("POST", path, { key: ws.keys.ops, body: { ids: ids.slice(0, 25), values, dry_run: false } })).status).toBe(200);
    const dry = await call("POST", path, { key: ws.keys.ops, body: { ids: ids.slice(0, 26), values } });
    expect(dry.json.confirm_token).toBeTruthy();
    // The token is bound to these ids: another set is refused.
    expect((await call("POST", path, { key: ws.keys.ops, body: { ids: ids.slice(1, 27), values, dry_run: false, confirm_token: dry.json.confirm_token } })).status).toBe(400);
    const run = await call("POST", path, { key: ws.keys.ops, body: { ids: [...ids.slice(0, 26)].reverse(), values, dry_run: false, confirm_token: dry.json.confirm_token } });
    expect(run.status).toBe(200);
    expect(run.json.counts.update).toBe(26);
  });

  it("merge: a real run needs its dry run's token, bound to the request and the records' versions", async () => {
    const s = await create(ws.keys.ops, "contact", { first_name: "Tok", email: uniqueEmail("tok") });
    const d = await create(ws.keys.ops, "contact", { first_name: "Tok2", email: uniqueEmail("tok2"), job_title: "T" });
    const body = { survivor: s.id, duplicates: [d.id] };
    const bare = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { ...body, dry_run: false } });
    expect(bare.status).toBe(400);
    const dry = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body });
    expect(dry.json.confirm_token).toBeTruthy();
    const otherFields = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { ...body, fields: { first_name: d.id }, dry_run: false, confirm_token: dry.json.confirm_token } });
    expect(otherFields.status).toBe(400);
    const someoneElse = await member();
    expect((await call("POST", "/v1/ops/merge_records", { key: someoneElse.key, body: { ...body, dry_run: false, confirm_token: dry.json.confirm_token } })).status).toBe(400);
    // A record changed after the preview: the merge would not be the one previewed.
    await call("PATCH", `/v1/objects/contact/records/${d.id}`, { key: ws.keys.ops, body: { job_title: "Changed" } });
    const stale = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { ...body, dry_run: false, confirm_token: dry.json.confirm_token } });
    expect(stale.status).toBe(409);
    expect(stale.json.detail).toMatch(/changed since the dry run/);
    expect((await get(d.id)).archived_at).toBeUndefined();
    const fresh = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body });
    const ok = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { ...body, dry_run: false, confirm_token: fresh.json.confirm_token } });
    expect(ok.status).toBe(200);
    expect(ok.json.survivor.job_title).toBe("Changed");
  });
});

describe("merge bounds", () => {
  it("is charged by its duplicates and checks the work budget", async () => {
    const m = await member();
    const recs = [];
    for (let i = 0; i < 11; i++) recs.push(await create(ws.keys.ops, "contact", { email: uniqueEmail(`cost${i}`) }));
    const body = { survivor: recs[0]!.id, duplicates: recs.slice(1).map((r) => r.id) };
    // 10 duplicates: 50 tokens a request, so a full bucket of 200 holds four.
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await call("POST", "/v1/ops/merge_records", { key: m.key, body })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
    const dry = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { survivor: recs[0]!.id, duplicates: [recs[1]!.id] } });
    WORK_BUDGET_MS.merge = 0;
    const out = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { survivor: recs[0]!.id, duplicates: [recs[1]!.id], dry_run: false, confirm_token: dry.json.confirm_token } });
    expect(out.status).toBe(503);
    expect(out.json.code).toBe("work_budget_exceeded");
    expect((await get(recs[1]!.id)).archived_at).toBeUndefined();
  });

  it(`refuses a merge that would move more than ${MERGE_MAX_REFERENCES} references, before anything changes`, async () => {
    const s = await create(ws.keys.ops, "contact", { email: uniqueEmail("capS") });
    const d = await create(ws.keys.ops, "contact", { email: uniqueEmail("capD") });
    const owner = uuid(ws.ownerId);
    await asApp(async (tx) => {
      await tx`INSERT INTO tasks (tenant_id, id, title, assignee_user_id) SELECT ${ws.tenantId}, gen_random_uuid(), ${`cap${stamp}`}, ${owner}
               FROM generate_series(1, ${MERGE_MAX_REFERENCES + 1})`;
      await tx`INSERT INTO task_associations (tenant_id, task_id, record_id) SELECT ${ws.tenantId}, id, ${uuid(d.id)} FROM tasks WHERE title = ${`cap${stamp}`}`;
    });
    const res = await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { survivor: s.id, duplicates: [d.id] } });
    expect(res.status).toBe(422);
    expect(res.json.detail).toMatch(/at most 1000.*Merge fewer duplicates at a time/s);
    expect((await get(d.id)).archived_at).toBeUndefined();
  });

  it("merges in one workspace run one at a time: concurrent contact and account merges over the same rows never fail", async () => {
    for (let round = 0; round < 6; round++) {
      const [a1, a2] = [await create(ws.keys.ops, "account", { name: `Lk A1 ${round}` }), await create(ws.keys.ops, "account", { name: `Lk A2 ${round}` })];
      const c1 = await create(ws.keys.ops, "contact", { email: uniqueEmail("lk1") });
      const c2 = await create(ws.keys.ops, "contact", { email: uniqueEmail("lk2") });
      // The same deals and account links refer to both duplicates; the two merges reach those tables in opposite orders.
      for (let i = 0; i < 3; i++) await create(ws.keys.ops, "deal", { name: `Lk ${i}`, primary_contact: c2.id, account: a2.id });
      await create(ws.keys.ops, "account_contact", { account: a2.id, contact: c2.id });
      const cb = { survivor: c1.id, duplicates: [c2.id] };
      const ab = { survivor: a1.id, duplicates: [a2.id] };
      const [cd, ad] = [await call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: cb }), await call("POST", "/v1/ops/merge_records", { key: ws.keys.admin, body: ab })];
      const out = await Promise.all([
        call("POST", "/v1/ops/merge_records", { key: ws.keys.ops, body: { ...cb, dry_run: false, confirm_token: cd.json.confirm_token } }),
        call("POST", "/v1/ops/merge_records", { key: ws.keys.admin, body: { ...ab, dry_run: false, confirm_token: ad.json.confirm_token } }),
      ]);
      expect(out.map((r) => r.status)).toEqual([200, 200]);
    }
  });
});

describe("merge references", () => {
  it("every foreign key into a mergeable table is classified in REFERENCES (a new one fails here until someone decides)", async () => {
    const fks = await sql<{ tbl: string; col: string }[]>`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey, c.confkey) AS k(attnum, fattnum)
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = k.fattnum
      WHERE c.contype = 'f' AND fa.attname = 'id' AND c.confrelid::regclass::text IN ('contacts', 'accounts', 'leads', 'records', 'record_registry')
      ORDER BY 1, 2`;
    const listed = new Set(REFERENCES.map((r) => `${r.table}.${r.column}`));
    const found = new Set(fks.map((f) => `${f.tbl}.${f.col}`));
    expect([...found].filter((x) => !listed.has(x)), "foreign keys into a mergeable table that REFERENCES doesn't classify").toEqual([]);
    expect([...listed].filter((x) => !found.has(x)), "REFERENCES entries with no foreign key").toEqual([]);
    for (const r of REFERENCES.filter((x) => x.policy === "dedupe")) expect(r.unique?.length, `${r.table}.${r.column}`).toBeGreaterThan(0);
  });

  it("each record whose reference moved gets a version bump and its .updated event (IDs only), and the audit entry names them", async () => {
    const s = await create(ws.keys.ops, "contact", { first_name: "Ev", email: uniqueEmail("evs") });
    const d = await create(ws.keys.ops, "contact", { first_name: "Ev2", email: uniqueEmail("evd") });
    const deal = await create(ws.keys.ops, "deal", { name: "Ev deal", primary_contact: d.id });
    const task = await create(ws.keys.ops, "task", { title: "Ev task", related_to: [d.id] });
    const note = (await call("POST", "/v1/ops/log_activity", { key: ws.keys.ops, body: { type: "call_logged", related_to: [d.id], actor_contact: d.id } })).json.data;
    const before = { deal: (await get(deal.id)).version, task: (await get(task.id)).version, note: (await get(note.id)).version };
    expect((await merge({ survivor: s.id, duplicates: [d.id] })).status).toBe(200);
    expect((await get(deal.id)).version).toBe(before.deal + 1);
    expect((await get(task.id)).version).toBe(before.task + 1);
    const act = await get(note.id);
    expect(act.version).toBeGreaterThan(before.note);
    expect(act.actor_contact).toBe(s.id);
    const ev = async (id: string) => (await call("GET", `/v1/events?record=${id}`, { key: ws.keys.ops })).json.data[0];
    expect(await ev(deal.id)).toMatchObject({ type: "deal.updated", data: { reference_move: true, before: { primary_contact: d.id }, after: { primary_contact: s.id } } });
    expect(await ev(task.id)).toMatchObject({ type: "task.updated", data: { reference_move: true, before: { related_to: [d.id] }, after: { related_to: [s.id] } } });
    expect(await ev(note.id)).toMatchObject({ type: "activity.updated", data: { reference_move: true, after: { actor_contact: s.id, related_to: [s.id] } } });
    const log = await call("GET", "/v1/audit-log?action=contact.merged", { key: ws.keys.admin });
    const entry = log.json.data.find((e: { record_id: string }) => e.record_id === uuid(s.id));
    expect(entry.details.moved).toEqual(expect.arrayContaining([
      { object: "deal", record: uuid(deal.id), fields: ["primary_contact"] }, { object: "task", record: uuid(task.id), fields: ["related_to"] }]));
  });

  it("a relation to an object the caller can't read is not filled, and said so (not a 403)", async () => {
    const acct = await create(ws.keys.ops, "account", { name: "Hidden Co" });
    const s = await create(ws.keys.ops, "contact", { email: uniqueEmail("nf") });
    const d = await create(ws.keys.ops, "contact", { email: uniqueEmail("nf2"), account: acct.id, job_title: "Kept" });
    const m = await member(ALL, { objects: { account: { read: false, write: false, archive: false } } });
    const dry = await call("POST", "/v1/ops/merge_records", { key: m.key, body: { survivor: s.id, duplicates: [d.id] } });
    expect(dry.status).toBe(200);
    expect(dry.json.not_filled).toEqual([{ field: "account", reason: expect.stringMatching(/can't read the records it points to/) }]);
    expect(dry.json.changes.map((c: { field: string }) => c.field)).toEqual(["job_title"]);
  });

  it("a merged record resolves to the final survivor through later merges, with the chain", async () => {
    const [a, b, c] = [await create(ws.keys.ops, "contact", { email: uniqueEmail("ch1") }), await create(ws.keys.ops, "contact", { email: uniqueEmail("ch2") }),
      await create(ws.keys.ops, "contact", { email: uniqueEmail("ch3") })];
    expect((await merge({ survivor: b.id, duplicates: [a.id] })).status).toBe(200);
    expect((await merge({ survivor: c.id, duplicates: [b.id] })).status).toBe(200);
    const got = await get(a.id);
    expect(got.merged_into).toBe(c.id);
    expect(got.merge_chain).toEqual([b.id, c.id]);
    const r = await call("POST", `/v1/objects/contact/records/${a.id}/restore`, { key: ws.keys.ops });
    expect(r.status).toBe(409);
    expect(r.json.detail).toContain(c.id);
  });

  it("a hierarchy cycle is refused without naming it to a role that can't read parent accounts", async () => {
    const z = await create(ws.keys.ops, "account", { name: "Cz" });
    const y = await create(ws.keys.ops, "account", { name: "Cy", parent_account: z.id });
    const x = await create(ws.keys.ops, "account", { name: "Cx", parent_account: y.id });
    const m = await member(ALL, { fields: { account: { parent_account: "none" } } });
    const res = await call("POST", "/v1/ops/merge_records", { key: m.key, body: { survivor: x.id, duplicates: [z.id] } });
    expect(res.status).toBe(409);
    expect(res.json.detail).not.toMatch(/parent|cycle|hierarchy/i);
  });
});

describe("database rules a merge relies on", () => {
  it("merges is append-only for the app role: no UPDATE, DELETE or TRUNCATE; spent tokens can't be changed", async () => {
    for (const stmt of ["UPDATE merges SET merged_by = NULL", "DELETE FROM merges", "TRUNCATE merges", "UPDATE confirm_tokens SET expires_at = now()", "TRUNCATE confirm_tokens"]) {
      const err = await asApp((tx) => tx.unsafe(stmt)).then(() => null, (e: { code?: string }) => e.code);
      expect(err, stmt).toBe("42501");
    }
  });

  it("the old app.repoint setting no longer relaxes the triggers, and app.merge_move refuses records that aren't a merge's", async () => {
    const c = await create(ws.keys.ops, "contact", { email: uniqueEmail("tr") });
    const c2 = await create(ws.keys.ops, "contact", { email: uniqueEmail("tr2") });
    const lead = await create(ws.keys.ops, "lead", { contact: c.id, status: "qualified" });
    expect((await call("POST", "/v1/ops/convert_lead", { key: ws.keys.ops, body: { lead: lead.id } })).status).toBe(200);
    const act = (await call("POST", "/v1/ops/log_activity", { key: ws.keys.ops, body: { type: "call_logged", related_to: [c.id], actor_contact: c.id } })).json.data;
    const attempt = (stmt: (tx: postgres.TransactionSql) => Promise<unknown>) => asApp(async (tx) => {
      await tx`SELECT set_config('app.repoint', 'on', true)`;
      return stmt(tx);
    }).then(() => null, (e: { code?: string; message?: string }) => e.message);
    expect(await attempt((tx) => tx`UPDATE leads SET contact_id = ${uuid(c2.id)} WHERE id = ${uuid(lead.id)}`)).toMatch(/converted lead is read-only/);
    expect(await attempt((tx) => tx`UPDATE activities SET actor_contact_id = ${uuid(c2.id)} WHERE id = ${uuid(act.id)}`)).toMatch(/cannot be edited/);
    // The function moves references only away from archived records of the survivor's object.
    expect(await attempt((tx) => tx`SELECT * FROM app.merge_move('leads', ${uuid(c2.id)}, ${[uuid(c.id)]}::uuid[], '{}', NULL)`)).toMatch(/must be archived/);
    expect(await attempt((tx) => tx`SELECT * FROM app.merge_move('deals', ${uuid(c2.id)}, ${[uuid(c.id)]}::uuid[], '{}', NULL)`)).toMatch(/invalid arguments/);
    expect((await get(lead.id)).contact).toBe(c.id);
  });
});
