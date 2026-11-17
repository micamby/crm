import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScheduler } from "../src/core/alerts.js";
import { VISIBLE_SEARCH_SCAN } from "../src/core/ops.js";
import { decodeId } from "../src/lib/ids.js";
import { processEvents } from "../src/worker/events.js";
import { call, create, memberWithKey, newWorkspace, uniqueEmail, type Workspace } from "./helpers.js";

/**
 * Copy paths (ADR 0008): the platform copies values from one record into another record, an activity
 * subject, a notification or a server-side filter, and the reader of the copy may have different rules
 * than the source. Each test here would fail without its fix: a value hidden on the source reached a
 * place the restricted role could read.
 */

const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
afterAll(() => sql.end());

const stamp = Date.now().toString(36);
let ws: Workspace;
let n = 0;
const ALL = ["records:read", "records:write", "records:archive"];
const OPS = ["ops:read", "ops:write"];
const has = (body: unknown, s: string) => JSON.stringify(body ?? null).includes(s);
const freeMail = (s: string) => uniqueEmail(s).replace("@example.com", "@gmail.com");
const drain = async () => { for (let i = 0; i < 10 && (await processEvents(ws.tenantId)) > 0; i++); };
const ownerGet = async (object: string, id: string) => (await call("GET", `/v1/objects/${object}/records/${id}`, { key: ws.keys.ops })).json.data;
const inbox = async (key: string) => (await call("GET", "/v1/me/notifications?state=all&limit=200", { key })).json.data as { title: string }[];

async function member(rules: Record<string, unknown>, permissions = ALL) {
  const r = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: `c${++n}_${stamp}`, name: "Copies", permissions, ...rules } });
  if (r.status !== 201) throw new Error(`role failed: ${r.status} ${JSON.stringify(r.json)}`);
  return memberWithKey(ws, r.json.data.key, OPS);
}

/** Runs `fn` as the app's database role, in the workspace's tenant: the way a manual fix or a migration would. */
const asApp = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) => sql.begin(async (tx) => {
  await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
  return fn(tx);
}) as Promise<T>;

beforeAll(async () => {
  ws = await newWorkspace("Record copies");
});

describe("values copied between records follow the caller's access to the source", () => {
  let acct: { id: string };
  let contact: { id: string };
  beforeAll(async () => {
    acct = await create(ws.keys.ops, "account", { name: `Employer ${stamp}` });
    contact = await create(ws.keys.ops, "contact", { first_name: "Hana", email: freeMail("hana"), account: acct.id });
  });

  it("a lead doesn't take its contact's account for a caller who can't read contact.account", async () => {
    const hidden = await member({ fields: { contact: { account: "none" } } });
    const made = await call("POST", "/v1/objects/lead/records", { key: hidden.key, body: { contact: contact.id, interest: "x" } });
    expect(made.status).toBe(201);
    expect(has(made.json, acct.id)).toBe(false);
    expect((await ownerGet("lead", made.json.data.id)).account).toBeNull();
    // A caller who can read it still gets the copy.
    const plain = await member({});
    const copied = await call("POST", "/v1/objects/lead/records", { key: plain.key, body: { contact: contact.id } });
    expect(copied.json.data.account).toBe(acct.id);
  });

  it("capture_interest neither reuses nor returns a hidden contact account (free-mail address, no domain)", async () => {
    const email = freeMail("cap");
    await create(ws.keys.ops, "contact", { email, account: acct.id });
    const hidden = await member({ fields: { contact: { account: "none" } } });
    const res = await call("POST", "/v1/ops/capture_interest", { key: hidden.key, body: { email, interest: "Widgets" } });
    expect(res.status).toBe(200);
    expect(res.json.result.account_id).toBeNull();
    expect(has(res.json, acct.id)).toBe(false);
    expect((await ownerGet("lead", res.json.result.lead.id)).account).toBeNull();
    // An unrestricted caller still gets the account on the lead and in the result.
    const plain = await call("POST", "/v1/ops/capture_interest", { key: ws.keys.ops, body: { email, interest: "More" } });
    expect(plain.json.result.account_id).toBe(acct.id);
    expect(plain.json.result.lead.account).toBe(acct.id);
  });

  it("convert_lead copies the lead's account only when the caller can read it, and needs lead.contact", async () => {
    const lead = await create(ws.keys.ops, "lead", { contact: contact.id, status: "qualified" });
    expect(lead.account).toBe(acct.id);
    const hidden = await member({ fields: { lead: { account: "none" } } });
    const res = await call("POST", "/v1/ops/convert_lead", { key: hidden.key, body: { lead: lead.id } });
    expect(res.status).toBe(200);
    expect(has(res.json, acct.id)).toBe(false);
    expect((await ownerGet("deal", res.json.result.deal.id)).account).toBeNull();
    const noContact = await member({ fields: { lead: { contact: "none" } } });
    const lead2 = await create(ws.keys.ops, "lead", { contact: contact.id, status: "qualified" });
    const refused = await call("POST", "/v1/ops/convert_lead", { key: noContact.key, body: { lead: lead2.id } });
    expect(refused.status).toBe(403);
    expect(refused.json.detail).toMatch(/lead\.contact/);
  });
});

describe("history activities have generic subjects and show what they are about through the reader's access", () => {
  it("lead_converted: a role denied deals sees neither the deal's name nor its display name", async () => {
    const DEAL = `zq${stamp}dealname`;
    const c = await create(ws.keys.ops, "contact", { first_name: "Ivo", email: uniqueEmail("ivo") });
    const lead = await create(ws.keys.ops, "lead", { contact: c.id, status: "qualified" });
    const conv = await call("POST", "/v1/ops/convert_lead", { key: ws.keys.ops, body: { lead: lead.id, deal_name: DEAL } });
    expect(conv.status).toBe(200);
    const noDeals = await member({ objects: { deal: { read: false, write: false, archive: false } } });
    for (const id of [lead.id, c.id]) {
      const tl = await call("GET", `/v1/records/${id}/timeline`, { key: noDeals.key });
      expect(tl.status).toBe(200);
      expect(has(tl.json, DEAL)).toBe(false);
      const act = tl.json.data.items.find((i: { item: { type: string } }) => i.item.type === "lead_converted").item;
      expect(act.subject).toBe("Lead converted to a deal");
      expect(act.related).toContainEqual({ id: conv.json.result.deal.id, object: "deal", display_name: null });
    }
    // Readers who can see the deal lose nothing: its name is on the link.
    const owner = await call("GET", `/v1/records/${lead.id}/timeline`, { key: ws.keys.ops });
    const act = owner.json.data.items.find((i: { item: { type: string } }) => i.item.type === "lead_converted").item;
    expect(act.related).toContainEqual({ id: conv.json.result.deal.id, object: "deal", display_name: DEAL });
  });

  it("task_completed: a role with task.title hidden doesn't see the title in the completion activity", async () => {
    const TITLE = `zq${stamp}tasktitle`;
    const c = await create(ws.keys.ops, "contact", { first_name: "Jun", email: uniqueEmail("jun") });
    const task = await create(ws.keys.ops, "task", { title: TITLE, related_to: [c.id] });
    expect((await call("PATCH", `/v1/objects/task/records/${task.id}`, { key: ws.keys.ops, body: { status: "done" } })).status).toBe(200);
    const noTitle = await member({ fields: { task: { title: "none" } } });
    const tl = await call("GET", `/v1/records/${c.id}/timeline`, { key: noTitle.key });
    expect(tl.status).toBe(200);
    expect(has(tl.json, TITLE)).toBe(false);
    const done = tl.json.data.items.find((i: { item: { type: string } }) => i.item.type === "task_completed").item;
    expect(done.subject).toBe("Task completed");
    expect(done.related_to).toContain(task.id); // linked to the task itself
    const owner = await call("GET", `/v1/records/${c.id}/timeline`, { key: ws.keys.ops });
    const mine = owner.json.data.items.find((i: { item: { type: string } }) => i.item.type === "task_completed").item;
    expect(mine.related).toContainEqual({ id: task.id, object: "task", display_name: TITLE });
  });

  it("form_submitted: a role with lead.interest hidden doesn't see the interest in the activity", async () => {
    const INTEREST = `zq${stamp}interest`;
    const email = uniqueEmail("kim");
    const res = await call("POST", "/v1/ops/capture_interest", { key: ws.keys.ops, body: { email, first_name: "Kim", interest: INTEREST } });
    expect(res.status).toBe(200);
    const noInterest = await member({ fields: { lead: { interest: "none" } } });
    const contactId = res.json.result.contact.id;
    const tl = await call("GET", `/v1/records/${contactId}/timeline`, { key: noInterest.key });
    expect(has(tl.json, INTEREST)).toBe(false);
    const form = tl.json.data.items.find((i: { item: { type: string } }) => i.item.type === "form_submitted").item;
    expect(form.subject).toBe("Form submitted");
    const owner = await call("GET", `/v1/records/${contactId}/timeline`, { key: ws.keys.ops });
    expect(has(owner.json, INTEREST)).toBe(true); // through the lead's display name
  });
});

describe("alerts and automation notify skip recipients who can't read what the rule looks at", () => {
  beforeAll(async () => {
    expect((await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "tier_code", type: "text" } })).status).toBe(201);
  });

  it("a workspace alert with a condition on a hidden field: warned on save, skipped on fire", async () => {
    const hidden = await member({ fields: { contact: { tier_code: "none" } } });
    const plain = await member({});
    const name = `Gold ${stamp}`;
    const alert = await call("POST", "/v1/alerts", { key: ws.keys.admin, body: {
      name, object: "contact", trigger: { type: "event", event: "contact.created" }, condition: { field: "tier_code", op: "eq", value: "gold" },
      recipients: { record_owner: false, users: [hidden.id, plain.id] } } });
    expect(alert.status).toBe(201);
    expect(alert.json.warnings.join(" ")).toContain(hidden.id);
    expect(alert.json.warnings.join(" ")).not.toContain(plain.id);
    await create(ws.keys.ops, "contact", { email: uniqueEmail("gold"), tier_code: "gold" });
    await create(ws.keys.ops, "contact", { email: uniqueEmail("lead"), tier_code: "lead" });
    await drain();
    expect((await inbox(plain.key)).filter((x) => x.title.startsWith(name)).length).toBe(1);
    expect((await inbox(hidden.key)).filter((x) => x.title.startsWith(name))).toEqual([]);
  });

  it("an event whose field is hidden (deal.stage_changed with deal.stage hidden) notifies nobody who can't read it", async () => {
    const hidden = await member({ fields: { deal: { stage: "none" } } });
    const name = `Moved ${stamp}`;
    const alert = await call("POST", "/v1/alerts", { key: ws.keys.admin, body: {
      name, object: "deal", trigger: { type: "event", event: "deal.stage_changed" }, recipients: { record_owner: false, users: [hidden.id, ws.ownerId] } } });
    expect(alert.json.warnings.join(" ")).toContain(hidden.id);
    const c = await create(ws.keys.ops, "contact", { email: uniqueEmail("mv") });
    const deal = await create(ws.keys.ops, "deal", { name: "Mover", primary_contact: c.id });
    await call("POST", "/v1/ops/move_deal_stage", { key: ws.keys.ops, body: { deal: deal.id, stage: "Proposal" } });
    await drain();
    expect((await inbox(ws.keys.ops)).some((x) => x.title.startsWith(name))).toBe(true);
    expect((await inbox(hidden.key)).some((x) => x.title.startsWith(name))).toBe(false);
  });

  it("automation notify with a condition on a hidden field: warned on save, skipped when it runs", async () => {
    const hidden = await member({ fields: { contact: { tier_code: "none" } } });
    const plain = await member({});
    const auto = await call("POST", "/v1/automations", { key: ws.keys.admin, body: {
      name: `Platinum ${stamp}`, trigger: { event: "contact.created" }, condition: { field: "tier_code", op: "eq", value: "platinum" },
      actions: [{ type: "notify", title: "Platinum contact", recipients: { users: [hidden.id, plain.id] } }] } });
    expect(auto.status).toBe(201);
    expect(auto.json.warnings.join(" ")).toContain(hidden.id);
    await create(ws.keys.ops, "contact", { email: uniqueEmail("plat"), tier_code: "platinum" });
    await drain();
    expect((await inbox(plain.key)).map((x) => x.title)).toContain("Platinum contact");
    expect((await inbox(hidden.key)).map((x) => x.title)).not.toContain("Platinum contact");
  });

  it("time alerts: field_passed on a hidden field and inactive for a role that can't read activities", async () => {
    const noDue = await member({ fields: { task: { due_at: "none" } } });
    const noActivities = await member({ objects: { activity: { read: false, write: false, archive: false } } });
    const plain = await member({});
    const overdue = `Overdue ${stamp}`;
    const quiet = `Quiet ${stamp}`;
    await create(ws.keys.ops, "task", { title: "Due soon", due_at: new Date(Date.now() + 3_600_000).toISOString() });
    const a1 = await call("POST", "/v1/alerts", { key: ws.keys.admin, body: {
      name: overdue, object: "task", trigger: { type: "field_passed", field: "due_at" }, recipients: { record_owner: false, users: [noDue.id, plain.id] } } });
    expect(a1.json.warnings.join(" ")).toContain(noDue.id);
    const a2 = await call("POST", "/v1/alerts", { key: ws.keys.admin, body: {
      name: quiet, object: "contact", trigger: { type: "inactive", days: 1 }, recipients: { record_owner: false, users: [noActivities.id, plain.id] } } });
    expect(a2.json.warnings.join(" ")).toContain(noActivities.id);
    await runScheduler(ws.tenantId, new Date(Date.now() + 3 * 86_400_000));
    const plainTitles = (await inbox(plain.key)).map((x) => x.title);
    expect(plainTitles.some((t) => t.startsWith(overdue))).toBe(true);
    expect(plainTitles.some((t) => t.startsWith(quiet))).toBe(true);
    expect((await inbox(noDue.key)).some((x) => x.title.startsWith(overdue))).toBe(false);
    expect((await inbox(noActivities.key)).some((x) => x.title.startsWith(quiet))).toBe(false);
  });

  it("a personal inactive alert needs read on activities", async () => {
    const noActivities = await member({ objects: { activity: { read: false, write: false, archive: false } } });
    const res = await call("POST", "/v1/me/alerts", { key: noActivities.key, body: { name: "Quiet", object: "contact", trigger: { type: "inactive", days: 3 }, mine_only: false } });
    expect(res.status).toBe(403);
    expect(res.json.detail).toMatch(/activities/);
    const plain = await member({});
    expect((await call("POST", "/v1/me/alerts", { key: plain.key, body: { name: "Quiet", object: "contact", trigger: { type: "inactive", days: 3 }, mine_only: false } })).status).toBe(201);
  });
});

describe("server-side task lists don't filter or sort on hidden task fields", () => {
  it("/v1/me/attention leaves out overdue tasks, with a note, when task.due_at is hidden", async () => {
    const noDue = await member({ fields: { task: { due_at: "none" } } });
    await create(ws.keys.ops, "task", { title: "Late", assignee: noDue.id, due_at: new Date(Date.now() - 3_600_000).toISOString() });
    const att = (await call("GET", "/v1/me/attention", { key: noDue.key })).json.data;
    expect(att.overdue_tasks).toBeNull();
    expect(att.overdue_tasks_note).toMatch(/task\.due_at/);
    const plain = await member({});
    await create(ws.keys.ops, "task", { title: "Late too", assignee: plain.id, due_at: new Date(Date.now() - 3_600_000).toISOString() });
    expect((await call("GET", "/v1/me/attention", { key: plain.key })).json.data.overdue_tasks.length).toBe(1);
  });

  it("/v1/me/tasks drops the open-status filter when task.status is hidden, and needs task.assignee", async () => {
    const noStatus = await member({ fields: { task: { status: "none" } } });
    const done = await create(ws.keys.ops, "task", { title: "Finished", assignee: noStatus.id, status: "done" });
    const open = await create(ws.keys.ops, "task", { title: "Open", assignee: noStatus.id });
    const ids = (await call("GET", "/v1/me/tasks", { key: noStatus.key })).json.data.map((t: { id: string }) => t.id);
    expect(ids).toEqual([open.id, done.id]); // all of my tasks, newest first: whether one is done can't be told from the list
    const noAssignee = await member({ fields: { task: { assignee: "none" } } });
    expect((await call("GET", "/v1/me/tasks", { key: noAssignee.key })).status).toBe(403);
  });
});

describe("search", () => {
  it("a read-only field rule keeps the search index (only hidden fields take the slower path)", async () => {
    const c = await create(ws.keys.ops, "contact", { first_name: "Before", email: uniqueEmail("stale") });
    // Change the name without refreshing the search text: the index path can't find the new name, the field path can.
    const NEW = `zq${stamp}stalename`;
    await asApp((tx) => tx`UPDATE contacts SET first_name = ${NEW} WHERE id = ${decodeId(c.id)!.uuid}`);
    const found = async (key: string) => (await call("GET", `/v1/search?q=${NEW}&objects=contact`, { key })).json.data.map((x: { id: string }) => x.id);
    expect(await found(ws.keys.ops)).toEqual([]);
    expect(await found((await member({ fields: { contact: { phone: "read" } } })).key)).toEqual([]);
    expect(await found((await member({ fields: { contact: { phone: "none" } } })).key)).toEqual([c.id]);
  });

  it("on an object with hidden fields it examines only the newest records, so it is bounded", async () => {
    const OLD = `zq${stamp}oldest`;
    await asApp(async (tx) => {
      // The lowest possible ID, then a full window of IDs above it (and below every real, time-ordered ID).
      await tx`INSERT INTO contacts (tenant_id, id, first_name, search_text) VALUES (${ws.tenantId}, '00000000-0000-4000-8000-000000000000', ${OLD}, ${OLD})`;
      await tx`INSERT INTO contacts (tenant_id, id, first_name, search_text)
               SELECT ${ws.tenantId}, ('00000000-0000-4000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, 'Filler', 'filler'
               FROM generate_series(1, ${VISIBLE_SEARCH_SCAN}) g`;
    });
    const fresh = await create(ws.keys.ops, "contact", { first_name: `${OLD}new`, email: uniqueEmail("fresh") });
    const hidden = await member({ fields: { contact: { phone: "none" } } });
    const started = Date.now();
    const res = await call("GET", `/v1/search?q=${OLD}&objects=contact`, { key: hidden.key });
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.json.data.map((x: { id: string }) => x.id)).toEqual([fresh.id]);
    expect((await call("GET", `/v1/search?q=${OLD}&objects=contact`, { key: ws.keys.ops })).json.data.length).toBe(2);
  });
});

describe("operations leave fields the caller can't write alone", () => {
  it("move_deal_stage keeps lost_reason for a caller who holds it read-only", async () => {
    const c = await create(ws.keys.ops, "contact", { email: uniqueEmail("lost") });
    const deal = await create(ws.keys.ops, "deal", { name: "Lost one", primary_contact: c.id });
    await call("POST", "/v1/ops/move_deal_stage", { key: ws.keys.ops, body: { deal: deal.id, stage: "Closed lost", lost_reason: "Too pricey" } });
    const ro = await member({ fields: { deal: { lost_reason: "read" } } });
    expect((await call("POST", "/v1/ops/move_deal_stage", { key: ro.key, body: { deal: deal.id, stage: "Discovery" } })).status).toBe(200);
    const after = await ownerGet("deal", deal.id);
    expect(after.lost_reason).toBe("Too pricey");
    expect(Number(after.probability)).toBe(25); // stage bookkeeping still applies
    // A caller who can write it clears it when the deal leaves the lost stage, as before.
    await call("POST", "/v1/ops/move_deal_stage", { key: ws.keys.ops, body: { deal: deal.id, stage: "Closed lost", lost_reason: "Again" } });
    await call("POST", "/v1/ops/move_deal_stage", { key: ws.keys.ops, body: { deal: deal.id, stage: "Discovery" } });
    expect((await ownerGet("deal", deal.id)).lost_reason).toBeNull();
  });
});

describe("rule changes made outside the app", () => {
  it("a rule written in SQL, as the app role, reaches every process on the next request", async () => {
    const SECRET = `zq${stamp}sqlrule`;
    const c = await create(ws.keys.ops, "contact", { first_name: "Sql", email: uniqueEmail("sql"), tier_code: SECRET });
    const r = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: `sqlrule_${stamp}`, name: "Sql", permissions: ALL } });
    const m = await memberWithKey(ws, r.json.data.key, OPS);
    expect((await call("GET", `/v1/records/${c.id}`, { key: m.key })).json.data.tier_code).toBe(SECRET); // rules now cached
    const roleId = decodeId(r.json.data.id)!.uuid;
    const version = async () => asApp(async (tx) => (await tx<{ v: string }[]>`SELECT access_version::text AS v FROM roles WHERE id = ${roleId}`)[0]!.v);
    const before = await version();
    await asApp(async (tx) => {
      const [me] = await tx<{ bypass: boolean }[]>`SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`;
      expect(me!.bypass).toBe(false); // the app role, under RLS
      const [f] = await tx<{ id: string }[]>`SELECT f.id FROM fields f JOIN objects o ON o.id = f.object_id WHERE o.api_name = 'contact' AND f.api_name = 'tier_code'`;
      await tx`INSERT INTO role_field_permissions (tenant_id, role_id, field_id, access) VALUES (${ws.tenantId}, ${roleId}, ${f!.id}, 'none')`;
    });
    expect(await version()).not.toBe(before);
    const seen = await call("GET", `/v1/records/${c.id}`, { key: m.key });
    expect("tier_code" in seen.json.data).toBe(false);
    expect(has(seen.json, SECRET)).toBe(false);
    // Deleting it in SQL takes effect the same way.
    await asApp((tx) => tx`DELETE FROM role_field_permissions WHERE role_id = ${roleId}`);
    expect((await call("GET", `/v1/records/${c.id}`, { key: m.key })).json.data.tier_code).toBe(SECRET);
  });
});

describe("schema managers have unrestricted record access", () => {
  it("schema:manage can't be combined with denying rules, in the API and in the database", async () => {
    const res = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: `schema_${stamp}`, name: "S", permissions: ["records:read", "schema:manage"],
      fields: { contact: { tier_code: "none" } } } });
    expect(res.status).toBe(422);
    expect(res.json.detail).toMatch(/schema:manage.*unrestricted record access/);
    const ok = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: `schema2_${stamp}`, name: "S", permissions: ["records:read", "schema:manage"] } });
    expect(ok.status).toBe(201);
    await expect(asApp(async (tx) => {
      const [f] = await tx<{ id: string }[]>`SELECT f.id FROM fields f JOIN objects o ON o.id = f.object_id WHERE o.api_name = 'contact' AND f.api_name = 'tier_code'`;
      await tx`INSERT INTO role_field_permissions (tenant_id, role_id, field_id, access) VALUES (${ws.tenantId}, ${decodeId(ok.json.data.id)!.uuid}, ${f!.id}, 'none')`;
    })).rejects.toThrow(/unrestricted record access/);
    // A limited role can't gain schema:manage later either.
    const limited = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: `schema3_${stamp}`, name: "S", permissions: ["records:read"], objects: { deal: { read: false } } } });
    expect((await call("PATCH", `/v1/roles/${limited.json.data.key}`, { key: ws.keys.admin, body: { permissions: ["records:read", "schema:manage"] } })).status).toBe(422);
  });
});

/**
 * Merge copies values from duplicates into the survivor, and moves references. Each case would let a
 * member read, through the survivor, a merge result or a bulk preview, a value it can't read on the source.
 */
describe("merges and bulk changes copy only what the caller can read and write", () => {
  const SECRET = `zq${stamp}mergecopy`;
  beforeAll(async () => {
    expect((await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "vault_code", type: "text", sensitivity: "restricted" } })).status).toBe(201);
  });

  it("a hidden relation, a hidden object and a restricted value stay where they were", async () => {
    const secretAcct = await create(ws.keys.ops, "account", { name: `${SECRET}acct` });
    const s = await create(ws.keys.ops, "contact", { first_name: "Surv", email: uniqueEmail("surv") });
    const d = await create(ws.keys.ops, "contact", { first_name: "Dup", email: uniqueEmail("dup"), account: secretAcct.id, vault_code: `${SECRET}vault`, job_title: "Visible" });
    const deal = await create(ws.keys.ops, "deal", { name: `${SECRET}deal`, primary_contact: d.id });
    const m = await member({ objects: { deal: { read: false, write: false, archive: false } }, fields: { contact: { account: "none" } } });
    const dry = await call("POST", "/v1/ops/merge_records", { key: m.key, body: { survivor: s.id, duplicates: [d.id] } });
    expect(dry.status).toBe(200);
    expect(dry.json.changes).toEqual([{ field: "job_title", before: null, after: "Visible", from: d.id }]);
    for (const v of [SECRET, secretAcct.id, deal.id]) expect(has(dry.json, v), v).toBe(false);
    expect(dry.json.references.some((r: { object: string }) => r.object === "deal")).toBe(false);
    // Choosing a value it can't read, or can't see unredacted, is refused before anything is looked up.
    expect((await call("POST", "/v1/ops/merge_records", { key: m.key, body: { survivor: s.id, duplicates: [d.id], fields: { account: d.id } } })).status).toBe(403);
    expect((await call("POST", "/v1/ops/merge_records", { key: m.key, body: { survivor: s.id, duplicates: [d.id], fields: { vault_code: d.id } } })).status).toBe(403);
    const real = await call("POST", "/v1/ops/merge_records", { key: m.key, body: { survivor: s.id, duplicates: [d.id], dry_run: false, confirm_token: dry.json.confirm_token } });
    expect(real.status).toBe(200);
    for (const v of [SECRET, secretAcct.id, deal.id]) expect(has(real.json, v), v).toBe(false);
    const after = await ownerGet("contact", s.id);
    expect(after.account).toBeNull(); // not filled: the member can't read it on the duplicate
    expect(after.vault_code).toBeNull(); // a restricted value moves only for a caller who can read it
    expect(after.job_title).toBe("Visible");
    // The deal still moved: bookkeeping on an object the member can't read, which would otherwise point at an archived record.
    expect((await ownerGet("deal", deal.id)).primary_contact).toBe(s.id);
    // A caller who can read both does fill them.
    const s2 = await create(ws.keys.ops, "contact", { first_name: "Surv2", email: uniqueEmail("surv2") });
    const d2 = await create(ws.keys.ops, "contact", { first_name: "Dup2", email: uniqueEmail("dup2"), account: secretAcct.id, vault_code: `${SECRET}vault` });
    const fullDry = await call("POST", "/v1/ops/merge_records", { key: ws.keys.admin, body: { survivor: s2.id, duplicates: [d2.id] } });
    const full = await call("POST", "/v1/ops/merge_records", { key: ws.keys.admin, body: { survivor: s2.id, duplicates: [d2.id], dry_run: false, confirm_token: fullDry.json.confirm_token } });
    expect(full.json.survivor).toMatchObject({ account: secretAcct.id, vault_code: `${SECRET}vault` });
  });

  it("the duplicate finder never groups by a hidden field, and bulk previews show only readable fields", async () => {
    const acct = await create(ws.keys.ops, "account", { name: "Shared employer" });
    const a = await create(ws.keys.ops, "contact", { first_name: "Same", last_name: "Name", email: uniqueEmail("sa"), account: acct.id, tier_code: `${SECRET}tier` });
    await create(ws.keys.ops, "contact", { first_name: "Same", last_name: "Name", email: uniqueEmail("sb"), account: acct.id, tier_code: `${SECRET}tier` });
    const m = await member({ fields: { contact: { account: "none", tier_code: "none" } } });
    expect((await call("POST", "/v1/objects/contact/duplicates", { key: m.key, body: { rules: [["tier_code"]] } })).status).toBe(403);
    expect((await call("POST", "/v1/objects/contact/duplicates", { key: m.key, body: { rules: [["first_name", "account"]] } })).status).toBe(403);
    const def = await call("POST", "/v1/objects/contact/duplicates", { key: m.key, body: {} });
    expect(def.json.skipped_rules).toEqual([{ rule: ["first_name", "last_name", "account"], reason: "this key can't read contact.account" }]);
    for (const v of [SECRET, acct.id]) expect(has(def.json, v), v).toBe(false);
    const preview = await call("POST", "/v1/objects/contact/records/bulk_update", { key: m.key, body: { ids: [a.id], values: { job_title: "x" } } });
    expect(preview.status).toBe(200);
    for (const v of [SECRET, acct.id]) expect(has(preview.json, v), v).toBe(false);
    const byFilter = await call("POST", "/v1/objects/contact/records/bulk_archive", { key: m.key, body: { where: { field: "id", op: "eq", value: a.id } } });
    expect(byFilter.json.sample).toHaveLength(1);
    for (const v of [SECRET, acct.id]) expect(has(byFilter.json, v), v).toBe(false);
  });

  it("a confirmed bulk run can't be widened or turned into another change", async () => {
    const tag = `wide${stamp}`;
    const one = await create(ws.keys.ops, "contact", { email: uniqueEmail("w1"), source: tag });
    const other = await create(ws.keys.ops, "contact", { email: uniqueEmail("w2"), source: `${tag}x` });
    const where = { field: "source", op: "eq", value: tag };
    const dry = await call("POST", "/v1/objects/contact/records/bulk_update", { key: ws.keys.ops, body: { where, values: { job_title: "T" } } });
    const token = dry.json.confirm_token as string;
    const tries: [string, unknown][] = [
      ["bulk_update", { where: { field: "source", op: "starts_with", value: tag }, values: { job_title: "T" }, dry_run: false, confirm_token: token }],
      ["bulk_update", { ids: [one.id, other.id], values: { job_title: "T" }, dry_run: false, confirm_token: token }],
      ["bulk_update", { where, values: { job_title: "T" }, expected_versions: { [one.id]: 1 }, dry_run: false, confirm_token: token }],
      ["bulk_archive", { where, dry_run: false, confirm_token: token }],
      ["bulk_update", { where, values: { job_title: "T" }, dry_run: false, confirm_token: `${token.split(".")[0]}x.${token.split(".")[1]}` }],
    ];
    for (const [op, body] of tries) {
      const res = await call("POST", `/v1/objects/contact/records/${op}`, { key: ws.keys.ops, body });
      expect([400, 422], JSON.stringify(body)).toContain(res.status);
    }
    expect((await call("POST", "/v1/objects/account/records/bulk_update", { key: ws.keys.ops, body: { where, values: { name: "T" }, dry_run: false, confirm_token: token } })).status).toBe(400);
    expect((await ownerGet("contact", other.id)).job_title).toBeNull();
    expect((await ownerGet("contact", one.id)).job_title).toBeNull();
    expect((await ownerGet("contact", one.id)).archived_at).toBeUndefined();
  });
});
