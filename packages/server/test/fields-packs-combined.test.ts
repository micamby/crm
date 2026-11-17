import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../cli/src/program.js";
import type { Runtime } from "../../cli/src/runtime.js";
import { formatDoc, parseDoc } from "../../cli/src/schemafile.js";
import { resetAuthLimiter, resetRateLimiter } from "../src/api/app.js";
import { resetSignInLimits } from "../src/auth/limits.js";
import { runQueuedOnce, scheduleDue } from "../src/core/automation-runner.js";
import { withTenant } from "../src/db/tx.js";
import { fillTemplates, RESTRICTED } from "../src/core/templates.js";
import { decodeId } from "../src/lib/ids.js";
import { resetMcpLimiter } from "../src/mcp/http.js";
import { setMailer } from "../src/providers/mailer.js";
import { processEvents } from "../src/worker/events.js";
import { app, Browser, call, create, FakeMailer, newWorkspace, signedIn, uniqueEmail, validate, type Schema, type Workspace } from "./helpers.js";
import { asMcpProcess, connectApp, mcpClient, registerClient, tool } from "./oauth-client.js";

/**
 * The five field types and schema packs (step5-fields-packs) together with the automation engine, people
 * sign-in and OAuth for MCP: automations that find by address parts and json paths, write each new type and
 * fill templates from them under the per-field budgets; run_roles and recipients that can't read an address
 * can't read its parts; pack plan tokens bound to each credential kind; packs refused for connected apps and
 * through MCP; an uninstall that names the automations and alert rules using what it would archive; and each
 * new type through an OAuth ops connection.
 */

const mailer = new FakeMailer();
let ws: Workspace;
let owner: Browser;
const appA = { clientId: "", redirectUri: "" };

beforeAll(async () => {
  setMailer(mailer);
  ws = await newWorkspace("Fields and packs combined");
  owner = await signedIn(ws.ownerEmail);
  Object.assign(appA, await registerClient("Fields and packs app"));
  for (const f of [
    { api_name: "hq", type: "address" }, { api_name: "meta", type: "json" }, { api_name: "score", type: "rating", options: { max: 5 } },
    { api_name: "share", type: "percent" }, { api_name: "wait", type: "duration" },
  ]) {
    const r = await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: f });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
  }
});
afterAll(() => setMailer(null as never));
beforeEach(() => {
  resetSignInLimits();
  resetAuthLimiter();
  resetMcpLimiter();
  resetRateLimiter();
});

async function drain(w: Workspace) {
  for (let i = 0; i < 60; i++) {
    const n = (await processEvents(w.tenantId)) + (await runQueuedOnce(w.tenantId) ? 1 : 0);
    if (n === 0) return;
  }
}

interface Run { status: string; reason: string | null; failure: string | null; results: { step: string; action: string; ok: boolean; skipped?: string; detail: Record<string, unknown> }[] }
const runsOf = async (id: string) => (await call("GET", `/v1/automations/${id}/runs?limit=50`, { key: ws.keys.admin })).json.data as Run[];
const saveAutomation = (body: Record<string, unknown>) => call("POST", "/v1/automations", { key: ws.keys.admin, body });
async function automation(body: Record<string, unknown>) {
  const r = await saveAutomation(body);
  if (r.status !== 201) throw new Error(`create automation: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.automation as { id: string };
}
async function member(role: string) {
  const email = uniqueEmail(role);
  const m = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email, name: `Combined ${role}`, role } });
  if (m.status !== 201) throw new Error(`add member failed: ${m.status} ${JSON.stringify(m.json)}`);
  return { id: m.json.data.id as string, email };
}

const AUSTIN = { line1: "1 Main St", city: "Austin", region: "TX", postal_code: "73301", country: "US" };

describe("automations with the new field types", () => {
  let noHq: { id: string; email: string };
  beforeAll(async () => {
    const role = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: "no_hq", name: "No HQ", permissions: ["records:read", "records:write"],
      fields: { contact: { hq: "none" } } } });
    expect(role.status, JSON.stringify(role.json)).toBe(201);
    noHq = await member("no_hq");
  });

  it("find by an address part and a json path, update a rating and a duration, and email a member unless their role hides the address", async () => {
    const tag = `fp${Date.now()}`;
    const hit = await create(ws.keys.ops, "contact", { first_name: "Hit", email: uniqueEmail(tag), source: tag, hq: AUSTIN, meta: { a: { b: "x" } },
      share: 12.5, wait: 5400 });
    const missJson = await create(ws.keys.ops, "contact", { first_name: "MissJson", email: uniqueEmail(tag), source: tag, hq: AUSTIN, meta: { a: { b: "y" } } });
    const missCity = await create(ws.keys.ops, "contact", { first_name: "MissCity", email: uniqueEmail(tag), source: tag, hq: { city: "Boston", country: "US" },
      meta: { a: { b: "x" } } });
    const body = "{{steps.f.first.first_name}} waits {{steps.f.first.wait | duration}}, share {{steps.f.first.share | percent}}, meta {{steps.f.first.meta.a.b}}, "
      + "at {{steps.f.first.hq.display}} ({{steps.f.first.hq.city | upper}})";
    const a = await automation({ name: "Austin leads", trigger: { type: "manual", object: "contact" }, actions: [
      { type: "find_records", id: "f", object: "contact", where: { and: [{ field: "source", op: "eq", value: tag }, { field: "hq.city", op: "eq", value: "Austin" },
        { field: "meta.a.b", op: "eq", value: "x" }] } },
      { type: "for_each", over: "f", steps: [{ type: "update_record", values: { score: 4, wait: "PT2H", share: "{{record.share}}" } }] },
      { type: "send_email", to: { member: noHq.id }, subject: "Lead in {{steps.f.first.hq.city}}", body },
      { type: "send_email", to: { member: ws.ownerId }, subject: "Lead in {{steps.f.first.hq.city}}", body },
    ] });
    const r = await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [hit.id] } });
    expect(r.status, JSON.stringify(r.json)).toBe(202);
    await drain(ws);
    const [run] = await runsOf(a.id);
    expect(run, JSON.stringify(run)).toMatchObject({ status: "succeeded" });
    expect(run!.results[0]!.detail).toMatchObject({ count: 1 });
    // The member whose role hides hq can't read hq.city or hq.display either: skipped, never emailed.
    const toLimited = run!.results.find((x) => x.action === "send_email" && x.skipped);
    expect(toLimited?.skipped).toMatch(/contact\.hq/);
    expect(mailer.lastTo(noHq.email)).toBeUndefined();
    const mail = mailer.lastTo(ws.ownerEmail)!;
    expect(mail.subject).toBe("Lead in Austin");
    expect(mail.text).toContain("Hit waits 1h 30m, share 12.5%, meta x, at 1 Main St, Austin, TX 73301, United States (AUSTIN)");

    const after = (await call("GET", `/v1/objects/contact/records/${hit.id}`, { key: ws.keys.admin })).json.data;
    expect(after).toMatchObject({ score: 4, wait: 7200, share: 12.5 });
    for (const miss of [missJson, missCity]) expect((await call("GET", `/v1/objects/contact/records/${miss.id}`, { key: ws.keys.admin })).json.data.score).toBeNull();
  });

  it("a run_roles member who can't read an address can't run an automation that sorts or filters by one of its parts", async () => {
    const m = await member("no_hq");
    const key = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "no hq key", scopes: ["ops:read", "ops:write"], owner: m.id } });
    const c = await create(ws.keys.ops, "contact", { first_name: "Rr", email: uniqueEmail("rr") });
    const sorts = await automation({ name: "Sorted by city", trigger: { type: "manual", object: "contact" }, run_roles: ["no_hq"], actions: [
      { type: "find_records", id: "f", object: "contact", sort: [{ field: "hq.city" }], limit: 1 },
      { type: "update_record", values: { job_title: "{{steps.f.first.first_name}}" } }] });
    const paths = await automation({ name: "By meta", trigger: { type: "manual", object: "contact" }, run_roles: ["no_hq"], actions: [
      { type: "update_record", if: { field: "meta.a", op: "eq", value: "x" }, values: { job_title: "meta" } }] });
    const plain = await automation({ name: "Plain", trigger: { type: "manual", object: "contact" }, run_roles: ["no_hq"], actions: [
      { type: "update_record", values: { job_title: "plain" } }] });
    const writesHq = await automation({ name: "Writes hq", trigger: { type: "manual", object: "contact" }, run_roles: ["no_hq"], actions: [
      { type: "update_record", values: { hq: { city: "Reno", country: "US" } } }] });
    const runAs = (id: string) => call("POST", `/v1/automations/${id}/run`, { key: key.json.data.secret, body: { records: [c.id] } });
    const refused = await runAs(sorts.id);
    expect(refused.status, JSON.stringify(refused.json)).toBe(403);
    expect(refused.json.detail).toMatch(/can't read/);
    const cantWrite = await runAs(writesHq.id);
    expect(cantWrite.status).toBe(403);
    // A json field the role can read is fine: only hq is hidden from it.
    expect((await runAs(paths.id)).status).toBe(202);
    expect((await runAs(plain.id)).status).toBe(202);
    await drain(ws);
  });

  it("checks the new types' values at save, and refuses parts, unknown address parts and an address or json upsert key", async () => {
    const bad = async (values: Record<string, unknown>, step: Record<string, unknown> = {}) => {
      const r = await saveAutomation({ name: "Bad", trigger: { type: "manual", object: "contact" }, actions: [{ type: "update_record", values, ...step }] });
      expect(r.status, JSON.stringify(r.json)).toBe(422);
      return r.json.detail as string;
    };
    expect(await bad({ score: 9 })).toMatch(/score/);
    expect(await bad({ share: "lots" })).toMatch(/share/);
    expect(await bad({ wait: "P1Y" })).toMatch(/wait/);
    expect(await bad({ meta: { blob: "x".repeat(17_000) } })).toMatch(/meta/);
    expect(await bad({ hq: { country: "ZZ" } })).toMatch(/hq/);
    expect(await bad({ hq: { town: "{{record.first_name}}" } })).toMatch(/unknown address parts: town/);
    expect(await bad({ hq: "{{record.first_name}} Street" })).toMatch(/an object of its parts/);
    expect(await bad({ "hq.city": "Austin" })).toMatch(/part of hq; write the whole address/);
    expect(await bad({ "meta.a": 1 })).toMatch(/part of meta; write the whole json value/);
    for (const key of ["hq", "meta"]) {
      const r = await saveAutomation({ name: "Bad key", trigger: { type: "manual", object: "contact" },
        actions: [{ type: "upsert_record", object: "contact", key, values: { [key]: { city: "x" }, email: "k@example.com" } }] });
      expect(r.status).toBe(422);
      expect(r.json.detail).toMatch(/upsert key must be id or a unique field/);
    }
    // Sorting by a whole address or a json path is refused at save, pointing at the parts.
    const sortBy = (field: string) => saveAutomation({ name: "Bad sort", trigger: { type: "schedule", every: { hours: 1 } },
      actions: [{ type: "find_records", id: "f", object: "contact", sort: [{ field }] }] });
    expect((await sortBy("hq")).json.detail).toMatch(/sort by its parts/);
    expect((await sortBy("meta.a")).status).toBe(422);
    expect((await sortBy("hq.city")).status).toBe(201);
  });

  it("writes each new type with create_record, upsert_record and update_record, filling address parts and json values from placeholders", async () => {
    const email = uniqueEmail("ups");
    const src = await create(ws.keys.ops, "contact", { first_name: "Src", last_name: "Tex", email: uniqueEmail("src"), hq: AUSTIN, meta: { n: 3, tags: ["a"] },
      score: 2, share: 33.3, wait: 60 });
    const a = await automation({ name: "Writers", trigger: { type: "manual", object: "contact" }, actions: [
      { type: "create_record", id: "made", object: "contact", values: { first_name: "Made", email: uniqueEmail("made"), hq: "{{record.hq}}", meta: "{{record.meta}}",
        score: "{{record.score}}", share: "{{record.share}}", wait: "{{record.wait}}" } },
      { type: "upsert_record", object: "contact", key: "email", values: { email, first_name: "Upserted", hq: { line1: "{{record.last_name}} Road", city: "{{record.hq.city}}", country: "us" },
        meta: { from: "{{record.id}}", n: "{{record.meta.n}}", fixed: [1, 2] }, score: 5, share: "50%", wait: "PT1M" } },
      { type: "update_record", values: { hq: { city: "{{record.hq.region}}", country: "{{record.hq.country}}" }, score: 1, share: 0.5, wait: "P1D" } },
    ] });
    await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [src.id] } });
    await drain(ws);
    const [run] = await runsOf(a.id);
    expect(run, JSON.stringify(run)).toMatchObject({ status: "succeeded" });
    const made = (await call("GET", `/v1/objects/contact/records/${run!.results[0]!.detail.record}`, { key: ws.keys.admin })).json.data;
    expect(made).toMatchObject({ hq: { ...AUSTIN, line2: null, display: "1 Main St, Austin, TX 73301, United States" }, meta: { n: 3, tags: ["a"] }, score: 2, share: 33.3, wait: 60 });
    const up = (await call("POST", "/v1/query", { key: ws.keys.admin, body: { object: "contact", where: { field: "email", op: "eq", value: email } } })).json.data[0];
    expect(up).toMatchObject({ first_name: "Upserted", hq: { line1: "Tex Road", city: "Austin", country: "US" }, meta: { from: src.id, n: 3, fixed: [1, 2] },
      score: 5, share: 50, wait: 60 });
    const self = (await call("GET", `/v1/objects/contact/records/${src.id}`, { key: ws.keys.admin })).json.data;
    expect(self).toMatchObject({ hq: { line1: null, city: "TX", country: "US", display: "TX, United States" }, score: 1, share: 0.5, wait: 86_400 });
  });

  it("applies each field's budget to filled values and fails a value its field refuses as a data failure", async () => {
    expect((await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "bio", type: "long_text" } })).status).toBe(201);
    const long = "y".repeat(5_000);
    const c = await create(ws.keys.ops, "contact", { first_name: "Budget", email: uniqueEmail("bud"), bio: long });
    const tooLong = await automation({ name: "Too long", trigger: { type: "manual", object: "contact" }, actions: [
      { type: "update_record", values: { hq: { line1: "{{record.bio}}" } } }] });
    const notRating = await automation({ name: "Not a rating", trigger: { type: "manual", object: "contact" }, actions: [
      { type: "update_record", values: { score: "{{record.first_name}}" } }] });
    for (const a of [tooLong, notRating]) await call("POST", `/v1/automations/${a.id}/run`, { key: ws.keys.admin, body: { records: [c.id] } });
    await drain(ws);
    const [r1] = await runsOf(tooLong.id);
    expect(r1).toMatchObject({ status: "failed", failure: "data" });
    expect(r1!.reason).toMatch(/contact\.hq would be longer than 4,096 characters/);
    const [r2] = await runsOf(notRating.id);
    expect(r2).toMatchObject({ status: "failed", failure: "data" });
  });

  it("keeps a restricted address out of templates, part by part", async () => {
    const f = await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "vault", type: "address", sensitivity: "restricted" } });
    expect(f.status, JSON.stringify(f.json)).toBe(201);
    for (const t of ["{{record.vault.city}}", "{{record.vault.display}}", "{{record.vault}}"]) {
      const r = await saveAutomation({ name: "Vault", trigger: { type: "manual", object: "contact" }, actions: [{ type: "update_record", values: { job_title: t } }] });
      expect(r.status, t).toBe(422);
      expect(r.json.detail).toMatch(/restricted field/);
    }
    // The runner holds a restricted value as a marker; a part of it is refused too, never filled as empty (a field that became restricted later).
    expect(() => fillTemplates({ job_title: "{{record.vault.city}}" }, { record: { vault: RESTRICTED }, event: null })).toThrow(/restricted value/);
    expect(() => fillTemplates({ hq: { city: "{{record.vault.city}}" } }, { record: { vault: RESTRICTED }, event: null })).toThrow(/restricted value/);
    expect(fillTemplates({ hq: { city: "{{record.hq.city}}", country: "US" }, score: "{{record.score}}" }, { record: { hq: { city: "Austin" }, score: 4 }, event: null }))
      .toEqual({ hq: { city: "Austin", country: "US" }, score: 4 });
    expect(fillTemplates({ t: "{{record.wait | duration}} / {{record.share | percent:1}}" }, { record: { wait: 93_784, share: 12.5 }, event: null }))
      .toEqual({ t: "1d 2h 3m 4s / 12.5%" });
  });

  it("runs a scheduled for_each over records sorted by an address part", async () => {
    const tag = `sch${Date.now()}`;
    const cities = ["Denver", "Austin", "Chicago"];
    const ids: Record<string, string> = {};
    for (const city of cities) ids[city] = (await create(ws.keys.ops, "contact", { first_name: city, email: uniqueEmail(tag), source: tag, hq: { city, country: "US" } })).id;
    const a = await automation({ name: "By city", trigger: { type: "schedule", every: { hours: 1 } }, actions: [
      { type: "for_each", query: { object: "contact", where: { field: "source", op: "eq", value: tag }, sort: [{ field: "hq.city", dir: "asc" }], limit: 10 },
        steps: [{ type: "update_record", values: { job_title: "{{item.hq.city}}", score: 3 } }] }] });
    await withTenant(ws.tenantId, (tx) => tx`UPDATE automations SET next_run_at = now() - interval '1 minute' WHERE id = ${decodeId(a.id)!.uuid}`);
    expect(await scheduleDue(ws.tenantId)).toBe(1);
    await drain(ws);
    const [run] = await runsOf(a.id);
    expect(run, JSON.stringify(run)).toMatchObject({ status: "succeeded" });
    expect(run!.results.filter((x) => x.action === "update_record").map((x) => x.detail.record)).toEqual(["Austin", "Chicago", "Denver"].map((c) => ids[c]));
    for (const city of cities) expect((await call("GET", `/v1/objects/contact/records/${ids[city]}`, { key: ws.keys.admin })).json.data).toMatchObject({ job_title: city, score: 3 });
  });
});

/** A small pack with every new type, a role and a view: on a standard object (contact) and an object of its own. */
const pack = (name: string, version = "1.0.0") => ({
  manifest: { name, version, parts: ["schema", "roles", "views"], license: "MIT" },
  schema: { objects: [
    { name: `${name.replace(/-/g, "_")}_site`, id_prefix: name.replace(/[^a-z]/g, "").slice(-4), display_field: "title", owned: true, fields: [
      { name: "title", type: "text", required: true }, { name: "where", type: "address" }, { name: "spec", type: "json" },
      { name: "stars", type: "rating", max: 10 }, { name: "uptime", type: "percent" }, { name: "lead_time", type: "duration" }] },
    { name: "contact", fields: [{ name: `${name.replace(/-/g, "_")}_level`, type: "rating", max: 3 }] },
  ] },
  roles: [{ key: `${name.replace(/-/g, "_")}_viewer`, name: "Pack viewer", permissions: ["records:read"],
    fields: { [`${name.replace(/-/g, "_")}_site`]: { spec: "none" } } }],
  views: [{ name: "By city", object: `${name.replace(/-/g, "_")}_site`, sort: [{ field: "where.country" }, { field: "where.city" }], columns: ["title", "where", "stars"] }],
});

describe("packs with each kind of credential", () => {
  it("a plan_token works only for the credential that planned: a key, a browser session (with CSRF), not an OAuth connection", async () => {
    const byKey = pack("cred-key");
    const p = await call("POST", "/v1/packs/plan", { key: ws.keys.admin, body: { pack: byKey } });
    expect(p.status, JSON.stringify(p.json).slice(0, 300)).toBe(200);
    // The session (the same member) can't apply the key's token, nor the key a session's.
    const crossed = await owner.request("POST", "/v1/packs/apply", { body: { pack: byKey, plan_token: p.json.plan_token } });
    expect(crossed.status).toBe(400);
    expect(crossed.json.detail).toMatch(/plan_token was issued for another request or credential/);
    const applied = await call("POST", "/v1/packs/apply", { key: ws.keys.admin, body: { pack: byKey, plan_token: p.json.plan_token } });
    expect(applied.status, JSON.stringify(applied.json).slice(0, 300)).toBe(200);
    // Single use.
    expect((await call("POST", "/v1/packs/apply", { key: ws.keys.admin, body: { pack: byKey, plan_token: p.json.plan_token } })).status).toBe(409);

    const bySession = pack("cred-session");
    expect((await owner.request("POST", "/v1/packs/plan", { body: { pack: bySession }, csrf: false })).status).toBe(403);
    const sp = await owner.request("POST", "/v1/packs/plan", { body: { pack: bySession } });
    expect(sp.status, JSON.stringify(sp.json).slice(0, 300)).toBe(200);
    expect((await call("POST", "/v1/packs/apply", { key: ws.keys.admin, body: { pack: bySession, plan_token: sp.json.plan_token } })).status).toBe(400);
    expect((await owner.request("POST", "/v1/packs/apply", { body: { pack: bySession, plan_token: sp.json.plan_token }, csrf: false })).status).toBe(403);
    const sa = await owner.request("POST", "/v1/packs/apply", { body: { pack: bySession, plan_token: sp.json.plan_token } });
    expect(sa.status, JSON.stringify(sa.json).slice(0, 300)).toBe(200);
    expect((await owner.request("GET", "/v1/packs")).json.data.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(["cred-key", "cred-session"]));

    // An OAuth admin connection of the owner: plan and list (read-only) work, apply and uninstall are refused,
    // and its plan_token is bound to the connection, so neither the key nor the session can apply it.
    const t = await connectApp(owner, appA, "admin", "admin ops:read ops:write");
    const byApp = pack("cred-app");
    const ap = await asMcpProcess(t.access_token, "admin", "POST", "/v1/packs/plan", { pack: byApp });
    expect(ap.status, JSON.stringify(ap.json).slice(0, 300)).toBe(200);
    expect((await asMcpProcess(t.access_token, "admin", "GET", "/v1/packs")).status).toBe(200);
    const refused = await asMcpProcess(t.access_token, "admin", "POST", "/v1/packs/apply", { pack: byApp, plan_token: ap.json.plan_token });
    expect(refused.status).toBe(403);
    expect(refused.json.detail).toMatch(/Connected apps can't install schema packs/);
    expect((await call("POST", "/v1/packs/apply", { key: ws.keys.admin, body: { pack: byApp, plan_token: ap.json.plan_token } })).status).toBe(400);
    expect((await owner.request("POST", "/v1/packs/apply", { body: { pack: byApp, plan_token: ap.json.plan_token } })).status).toBe(400);
    expect((await asMcpProcess(t.access_token, "admin", "POST", "/v1/packs/cred-key/uninstall", {})).status).toBe(403);
    // A key's client that says it is an MCP server is refused too.
    const viaMcp = await call("POST", "/v1/packs/apply", { key: ws.keys.admin, headers: { "X-Hlcrm-Surface": "admin-mcp" },
      body: { pack: byApp, plan_token: (await call("POST", "/v1/packs/plan", { key: ws.keys.admin, body: { pack: byApp } })).json.plan_token } });
    expect(viaMcp.status).toBe(403);
    expect((await call("GET", "/v1/packs", { key: ws.keys.admin })).json.data.map((x: { name: string }) => x.name)).not.toContain("cred-app");
  });

  it("a pack's own role is refused when it grants what the installer lacks, and creating keys still needs a recent sign-in", async () => {
    const limited = await call("POST", "/v1/roles", { key: ws.keys.admin, body: { key: "pack_admin_ro", name: "Pack admin", permissions: ["roles:manage", "schema:manage", "views:manage", "records:read"] } });
    expect(limited.status, JSON.stringify(limited.json)).toBe(201);
    const m = await member("pack_admin_ro");
    const key = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "pack admin", scopes: ["admin", "ops:read"], owner: m.id } });
    const p = pack("escalates");
    p.roles[0]!.permissions = ["records:read", "records:write"];
    const r = await call("POST", "/v1/packs/plan", { key: key.json.data.secret, body: { pack: p } });
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(403);
    expect(r.json.detail).toMatch(/roles\.escalates_viewer: This role would grant permissions you don't hold: records:write/);
    // The same pack with a role inside what the installer holds plans and applies with the installer's own key.
    p.roles[0]!.permissions = ["records:read"];
    const ok = await call("POST", "/v1/packs/plan", { key: key.json.data.secret, body: { pack: p } });
    expect(ok.status, JSON.stringify(ok.json).slice(0, 300)).toBe(200);
    // Unrelated rule from sign-in: a session creates keys only soon after signing in; a fresh one still can, packs or not.
    const k = await owner.request("POST", "/v1/api-keys", { body: { name: "fresh", scopes: ["ops:read"] } });
    expect(k.status, JSON.stringify(k.json)).toBe(201);
  });
});

describe("uninstalling a pack that automations and alert rules use", () => {
  it("names them in the dry run and refuses the real run until they no longer use it", async () => {
    const p = pack("in-use");
    const a = await call("POST", "/v1/packs/plan", { key: ws.keys.admin, body: { pack: p } });
    expect((await call("POST", "/v1/packs/apply", { key: ws.keys.admin, body: { pack: p, plan_token: a.json.plan_token } })).status).toBe(200);
    const writes = await automation({ name: "Sets the level", trigger: { type: "manual", object: "contact" }, actions: [{ type: "update_record", values: { in_use_level: 2 } }] });
    const runs = await automation({ name: "Run by pack role", trigger: { type: "manual", object: "contact" }, run_roles: ["in_use_viewer"],
      actions: [{ type: "notify", title: "Hi", recipients: { record_owner: true } }] });
    const finds = await automation({ name: "Finds sites", trigger: { type: "schedule", every: { hours: 1 } },
      actions: [{ type: "find_records", id: "f", object: "in_use_site", where: { field: "where.city", op: "eq", value: "Austin" } }] });
    const unrelated = await automation({ name: "Unrelated", trigger: { type: "manual", object: "contact" }, actions: [{ type: "update_record", values: { job_title: "x" } }] });
    const alert = await call("POST", "/v1/alerts", { key: ws.keys.admin, body: { name: "Low stars", object: "in_use_site", trigger: { type: "event", event: "in_use_site.updated" },
      condition: { field: "stars", op: "lte", value: 2 }, recipients: { users: [ws.ownerId] } } });
    expect(alert.status, JSON.stringify(alert.json)).toBe(201);

    const dry = await call("POST", "/v1/packs/in-use/uninstall", { key: ws.keys.admin, body: {} });
    expect(dry.status, JSON.stringify(dry.json).slice(0, 500)).toBe(200);
    const inUse = dry.json.in_use as { kind: string; id: string; name: string; uses: string[] }[];
    expect(Object.fromEntries(inUse.map((u) => [u.id, u.uses]))).toEqual({
      [writes.id]: ["contact.in_use_level"], [runs.id]: ["run_roles: in_use_viewer"], [finds.id]: ["in_use_site records"], [alert.json.alert.id]: ["in_use_site records"],
    });
    expect(inUse.map((u) => u.id)).not.toContain(unrelated.id);
    const refused = await call("POST", "/v1/packs/in-use/uninstall", { key: ws.keys.admin, body: { dry_run: false, confirm_token: dry.json.confirm_token } });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("pack_in_use");
    expect(refused.json.detail).toContain(writes.id);

    for (const x of [writes, runs, finds]) expect((await call("DELETE", `/v1/automations/${x.id}`, { key: ws.keys.admin })).status).toBe(200);
    expect((await call("DELETE", `/v1/alerts/${alert.json.alert.id}`, { key: ws.keys.admin })).status).toBe(200);
    const again = await call("POST", "/v1/packs/in-use/uninstall", { key: ws.keys.admin, body: {} });
    expect(again.json.in_use).toEqual([]);
    const done = await call("POST", "/v1/packs/in-use/uninstall", { key: ws.keys.admin, body: { dry_run: false, confirm_token: again.json.confirm_token } });
    expect(done.status, JSON.stringify(done.json).slice(0, 300)).toBe(200);
  });
});

describe("the new types through an OAuth ops connection", () => {
  it("queries by parts and paths, aggregates by parts and measures ratings, percents and durations, and writes each type", async () => {
    const t = await connectApp(owner, appA, "ops", "ops:read ops:write");
    const c = await mcpClient("ops", t.access_token);
    const tag = `oa${Date.now()}`;
    const rows = [
      { first_name: "Oa", hq: { city: "Austin", country: "US" }, meta: { tier: "gold" }, score: 5, share: 10, wait: 60 },
      { first_name: "Ob", hq: { city: "Austin", country: "US" }, meta: { tier: "gold" }, score: 3, share: 30, wait: 120 },
      { first_name: "Oc", hq: { city: "Berlin", country: "DE" }, meta: { tier: "silver" }, score: 1, share: 50, wait: 180 },
    ];
    // Writes through the app: create, then update each type.
    const ids: string[] = [];
    for (const row of rows) {
      const r = await tool(c, "create_record", { object: "contact", values: { ...row, email: uniqueEmail(tag), source: tag } });
      expect(r.isError, r.text).toBe(false);
      ids.push((r.result as { id: string }).id);
    }
    const u = await tool(c, "update_record", { id: ids[2]!, values: { hq: { city: "Munich", country: "de" }, meta: { tier: "bronze" }, score: 2, share: "55.5%", wait: "PT5M" } });
    expect(u.isError, u.text).toBe(false);
    expect(u.result).toMatchObject({ hq: { city: "Munich", country: "DE", display: "Munich, Germany" }, meta: { tier: "bronze" }, score: 2, share: 55.5, wait: 300 });

    const q = await tool(c, "query_records", { object: "contact", where: { and: [{ field: "source", op: "eq", value: tag }, { field: "hq.city", op: "eq", value: "Austin" },
      { field: "meta.tier", op: "eq", value: "gold" }] }, sort: [{ field: "hq.city" }, { field: "score", dir: "desc" }], count: true, fields: ["first_name", "hq", "score"] });
    expect(q.isError, q.text).toBe(false);
    const page = q.result as { data: { first_name: string; hq: { city: string } }[]; total: number };
    expect(page.total).toBe(2);
    expect(page.data.map((r) => r.first_name)).toEqual(["Oa", "Ob"]);

    const agg = await tool(c, "aggregate_records", { object: "contact", where: { field: "source", op: "eq", value: tag }, group_by: [{ field: "hq.country" }],
      measures: [{ op: "count" }, { op: "avg", field: "score" }, { op: "max", field: "share" }, { op: "sum", field: "wait" }] });
    expect(agg.isError, agg.text).toBe(false);
    const groups = (agg.result as { data: Record<string, unknown>[] }).data;
    expect(groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ group: { "hq.country": "US" }, count: 2, values: { avg_score: 4, max_share: 30, sum_wait: 180 } }),
      expect.objectContaining({ group: { "hq.country": "DE" }, count: 1, values: { avg_score: 2, max_share: 55.5, sum_wait: 300 } }),
    ]));
    // A whole address or json value can't be sorted or grouped: a 422 the model can read, never a 500.
    expect((await tool(c, "aggregate_records", { object: "contact", group_by: [{ field: "meta" }] })).isError).toBe(true);
    expect((await tool(c, "query_records", { object: "contact", sort: [{ field: "hq" }] })).text).toMatch(/sort by its parts/);

    // The same through an API key on the same MCP endpoint.
    const kc = await mcpClient("ops", ws.keys.ops);
    const kq = await tool(kc, "query_records", { object: "contact", where: { and: [{ field: "source", op: "eq", value: tag }, { field: "meta.tier", op: "eq", value: "bronze" }] } });
    expect((kq.result as { data: { first_name: string }[] }).data.map((r) => r.first_name)).toEqual(["Oc"]);
  });

  it("adds fields of the new types through the admin tools with an OAuth admin connection", async () => {
    const t = await connectApp(owner, appA, "admin", "admin ops:read ops:write");
    const c = await mcpClient("admin", t.access_token);
    const add = await tool(c, "add_field", { object: "contact", name: "nps", type: "rating", max: 10, dry_run: false });
    expect(add.isError, add.text).toBe(false);
    const shape = await tool(c, "add_field", { object: "contact", name: "prefs", type: "json", shape: { type: "object", properties: { lang: "string" } }, dry_run: false });
    expect(shape.isError, shape.text).toBe(false);
    const raise = await tool(c, "update_field", { object: "contact", field: "nps", max: 10, dry_run: false });
    expect(raise.isError, raise.text).toBe(false);
    const d = (await call("GET", "/v1/objects/contact", { key: ws.keys.admin })).json.data.fields as { name: string; max?: number; shape?: unknown }[];
    expect(d.find((f) => f.name === "nps")).toMatchObject({ type: "rating", max: 10 });
    expect(d.find((f) => f.name === "prefs")).toMatchObject({ type: "json", shape: { type: "object", properties: { lang: "string" } } });
  });
});

describe("the OpenAPI document with the new types, packs and automations", () => {
  const declared = (doc: Schema, template: string, method: string, status = 200): Schema =>
    (doc.paths as Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: Schema }> }> }>>)[template]![method]!
      .responses[String(status)]!.content["application/json"]!.schema;

  it("validates what is written against the object's write schema, and real responses against the declared ones", async () => {
    const doc = (await call("GET", "/v1/openapi.json", { key: ws.keys.admin })).json as Schema;
    const written = { first_name: "Doc", email: uniqueEmail("doc"), hq: { ...AUSTIN, display: "ignored" }, meta: { a: [1, { b: null }] }, score: 5, share: "12.5%", wait: "PT1H30M" };
    expect(validate(doc, { $ref: "#/components/schemas/contact" }, written)).toEqual([]);
    // The write schema refuses what the server refuses: an unknown address part, a rating past the field's max.
    expect(validate(doc, { $ref: "#/components/schemas/contact" }, { ...written, hq: { town: "x" } }).length).toBeGreaterThan(0);
    expect(validate(doc, { $ref: "#/components/schemas/contact" }, { ...written, score: 6 }).length).toBeGreaterThan(0);
    const made = await call("POST", "/v1/objects/contact/records", { key: ws.keys.ops, body: written });
    expect(made.status).toBe(201);
    expect(validate(doc, declared(doc, "/v1/objects/{object}/records", "post", 201), made.json)).toEqual([]);
    const id = made.json.data.id as string;
    const pk = pack("doc-pack");
    const plan = await call("POST", "/v1/packs/plan", { key: ws.keys.admin, body: { pack: pk } });
    const samples: [string, string, string, unknown][] = [
      ["GET", "/v1/objects/{object}/records/{id}", `/v1/objects/contact/records/${id}`, undefined],
      ["GET", "/v1/records/{id}", `/v1/records/${id}`, undefined],
      ["GET", "/v1/objects/{object}/records", "/v1/objects/contact/records?fields=hq,meta,score,share,wait&limit=5&count=true", undefined],
      ["POST", "/v1/query", "/v1/query", { object: "contact", where: { field: "hq.city", op: "eq", value: "Austin" }, sort: [{ field: "hq.city" }, { field: "wait", dir: "desc" }], limit: 3 }],
      ["POST", "/v1/aggregate", "/v1/aggregate", { object: "contact", group_by: [{ field: "hq.country" }, { field: "score" }],
        measures: [{ op: "avg", field: "share" }, { op: "sum", field: "wait" }, { op: "max", field: "score" }] }],
      ["PATCH", "/v1/objects/{object}/records/{id}", `/v1/objects/contact/records/${id}`, { hq: { city: "Reno" }, meta: null, score: 1, share: 0, wait: 0 }],
      ["GET", "/v1/objects/{object}", "/v1/objects/contact", undefined],
      ["POST", "/v1/packs/apply", "/v1/packs/apply", { pack: pk, plan_token: plan.json.plan_token }],
      ["GET", "/v1/packs", "/v1/packs", undefined],
      ["POST", "/v1/packs/{name}/uninstall", "/v1/packs/doc-pack/uninstall", {}],
    ];
    expect(validate(doc, declared(doc, "/v1/packs/plan", "post"), plan.json)).toEqual([]);
    for (const [method, template, path, body] of samples) {
      const res = await call(method, path, { key: ws.keys.admin, body });
      expect(res.status, `${path} ${JSON.stringify(res.json).slice(0, 300)}`).toBe(200);
      expect(validate(doc, declared(doc, template, method.toLowerCase()), res.json), `${method} ${path}`).toEqual([]);
    }
  });
});

describe("the CLI with the new types, packs and automations", () => {
  const apiFetch: typeof fetch = async (input, init) => app.request(input instanceof Request ? input : String(input), init);
  let home = "";
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "crm-fields-packs-"));
  });
  async function crm(args: string[], key = ws.keys.admin) {
    const out: string[] = [];
    const err: string[] = [];
    const rt: Runtime = {
      stdout: (s) => void out.push(s), stderr: (s) => void err.push(s), readStdin: async () => "", promptSecret: async () => "",
      confirm: async () => false, env: { HLCRM_API_URL: "http://localhost", HLCRM_API_KEY: key, HLCRM_CONFIG_DIR: join(home, "config") },
      interactive: false, stdoutIsTTY: false, cwd: home, fetch: apiFetch,
    };
    const code = await run(args, rt);
    return { code, out: out.join(""), err: err.join("") };
  }

  it("lists pack and automations in help, and passes doctor", async () => {
    const help = await crm(["--help"]);
    expect(help.out).toMatch(/\bpack\b/);
    expect(help.out).toMatch(/\bautomations\b/);
    expect((await crm(["pack", "--help"])).out).toMatch(/uninstall/);
    const doctor = await crm(["doctor", "--json"]);
    expect(doctor.code, doctor.err).toBe(0);
  });

  it("round-trips every new type through schema pull, plan and apply", async () => {
    const path = join(home, "crm.schema.yaml");
    expect((await crm(["schema", "pull", "-o", path])).code).toBe(0);
    const doc = parseDoc(readFileSync(path, "utf8"), path) as { objects: { name: string; fields: Record<string, unknown>[] }[] };
    const contact = doc.objects.find((o) => o.name === "contact")!;
    expect(contact.fields.find((f) => f.name === "score")).toMatchObject({ type: "rating", max: 5 });
    for (const t of ["address", "json", "percent", "duration"]) expect(contact.fields.some((f) => f.type === t), t).toBe(true);
    expect((await crm(["schema", "plan", "-f", path])).code).toBe(0);
    contact.fields.push({ name: "cli_where", type: "address" }, { name: "cli_spec", type: "json", shape: { type: "object" } }, { name: "cli_stars", type: "rating", max: 7 },
      { name: "cli_pct", type: "percent" }, { name: "cli_wait", type: "duration" });
    writeFileSync(path, formatDoc(doc as never, path));
    const plan = await crm(["schema", "plan", "-f", path]);
    expect(plan.code, plan.err).toBe(5);
    expect(plan.out).toContain("+ add field contact.cli_where (address)");
    const applied = await crm(["schema", "apply", "-f", path, "--yes"]);
    expect(applied.code, applied.err).toBe(0);
    expect(applied.out).toContain("Applied 5 change(s)");
    expect((await crm(["schema", "pull", "-o", path])).code).toBe(0);
    expect((await crm(["schema", "plan", "-f", path])).code).toBe(0);
    const again = parseDoc(readFileSync(path, "utf8"), path) as { objects: { name: string; fields: Record<string, unknown>[] }[] };
    expect(again.objects.find((o) => o.name === "contact")!.fields.find((f) => f.name === "cli_stars")).toMatchObject({ type: "rating", max: 7 });
  });

  it("pack uninstall names the automations that use the pack and exits with a conflict", async () => {
    const p = pack("cli-packed");
    const dir = join(home, "cli-packed");
    mkdirSync(dir);
    writeFileSync(join(dir, "pack.yaml"), JSON.stringify(p.manifest));
    writeFileSync(join(dir, "schema.yaml"), JSON.stringify(p.schema));
    writeFileSync(join(dir, "roles.yaml"), JSON.stringify({ roles: p.roles }));
    writeFileSync(join(dir, "views.yaml"), JSON.stringify({ views: p.views }));
    const installed = await crm(["--yes", "pack", "install", dir]);
    expect(installed.code, installed.err + installed.out).toBe(0);
    const a = await automation({ name: "Uses the cli pack", trigger: { type: "manual", object: "contact" }, actions: [{ type: "update_record", values: { cli_packed_level: 1 } }] });
    const r = await crm(["--yes", "pack", "uninstall", "cli-packed"]);
    expect(r.code).toBe(4);
    expect(r.out).toContain(`automation ${a.id} Uses the cli pack: contact.cli_packed_level`);
    expect(r.err).toMatch(/pack_in_use|Change or archive them first/);
  });
});
