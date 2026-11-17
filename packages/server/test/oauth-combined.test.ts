import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HEAVY_LIMITS, resetAuthLimiter, resetRateLimiter } from "../src/api/app.js";
import { resetSignInLimits } from "../src/auth/limits.js";
import { decodeId } from "../src/lib/ids.js";
import { oauthSettings } from "../src/config.js";
import { buildMcpApp, resetMcpLimiter } from "../src/mcp/http.js";
import { processEvents } from "../src/worker/events.js";
import { app, call, create, newWorkspace, signedIn, uniqueEmail, validate, type Browser, type Schema, type Workspace } from "./helpers.js";
import { asMcpProcess, connectApp, mcpClient, registerClient, tool } from "./oauth-client.js";

/**
 * OAuth connections (ADR 0010) together with people sign-in, the read side and the write side.
 *
 * The rule for identity (core/context.ts `credential`): a connected app is its grant, `oauth:<grant>`,
 * a credential of its own beside the member's API keys (`key:<id>`) and browser sessions
 * (`user:<tenant>:<member>`). Its rate limit, route costs, heavy-request slots (2, and 4 across all of one
 * member's apps), idempotency records and confirm tokens all key on it. Everything runs through the
 * in-process MCP app, which presents the token to the API with MCP_SERVICE_SECRET like the real MCP process.
 */

const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 2, onnotice: () => {} });
afterAll(() => sql.end());

let ws: Workspace;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uuid = (id: string) => decodeId(id)!.uuid;
const appA = { clientId: "", redirectUri: "" };
const appB = { clientId: "", redirectUri: "" };

/** A member with the `member` role, signed in, with an ops key of their own. */
async function member(role = "member") {
  const email = uniqueEmail("oc");
  const m = await call("POST", "/v1/members", { key: ws.keys.admin, body: { email, name: "OAuth Combined", role } });
  if (m.status !== 201) throw new Error(`add member failed: ${m.status} ${JSON.stringify(m.json)}`);
  const id = m.json.data.id as string;
  const k = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "own key", scopes: ["ops:read", "ops:write"], owner: id } });
  if (k.status !== 201) throw new Error(`create key failed: ${k.status} ${JSON.stringify(k.json)}`);
  return { id, email, key: k.json.data.secret as string, browser: await signedIn(email) };
}

/** Holds a row lock on a contact for `ms`, so a real bulk change of it stays in flight (and holds a heavy slot). */
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

const grantOf = async (b: Browser, client: { clientId: string }) =>
  ((await b.request("GET", "/v1/auth/apps")).json.data as { id: string; client: { id: string } }[]).find((g) => g.client.id === client.clientId)!.id;

beforeAll(async () => {
  ws = await newWorkspace("OAuth combined");
  Object.assign(appA, await registerClient("Combined App A"));
  Object.assign(appB, await registerClient("Combined App B", "https://chatgpt.com/connector_platform_oauth_redirect"));
});
beforeEach(() => {
  resetSignInLimits();
  resetAuthLimiter();
  resetMcpLimiter();
  resetRateLimiter();
});
afterEach(() => {
  HEAVY_LIMITS.perCredential = 2;
  HEAVY_LIMITS.perMemberApps = 4;
});

describe("the read side through a connected app", () => {
  it("lists with several sort fields and a count, aggregates, and uses the member's own saved view by view=", async () => {
    const m = await member();
    const t = await connectApp(m.browser, appA, "ops", "ops:read ops:write");
    const tag = `rd${Date.now()}`;
    for (const [first, last] of [["Ann", "Zed"], ["Ann", "Abe"], ["Bob", "Kim"]]) {
      await create(ws.keys.ops, "contact", { first_name: first, last_name: last, email: uniqueEmail(tag), job_title: tag });
    }
    const c = await mcpClient("ops", t.access_token);
    const listed = await tool(c, "query_records", { object: "contact", where: { field: "job_title", op: "eq", value: tag }, count: true,
      sort: [{ field: "first_name", dir: "asc" }, { field: "last_name", dir: "desc" }] });
    expect(listed.isError, listed.text).toBe(false);
    const page = listed.result as { data: { first_name: string; last_name: string }[]; total: number };
    expect(page.total).toBe(3);
    expect(page.data.map((r) => `${r.first_name} ${r.last_name}`)).toEqual(["Ann Zed", "Ann Abe", "Bob Kim"]);

    const agg = await tool(c, "aggregate_records", { object: "contact", where: { field: "job_title", op: "eq", value: tag }, group_by: [{ field: "first_name" }] });
    expect(agg.isError, agg.text).toBe(false);
    expect((agg.result as { data: { group: { first_name: string }; count: number }[] }).data.map((g) => [g.group.first_name, g.count])).toEqual([["Ann", 2], ["Bob", 1]]);

    // /v1/me/* is the member's: a personal view saved in the browser is the app's to use, and one the app saves is the browser's.
    const view = await m.browser.request("POST", "/v1/views", { body: { object: "contact", name: `Anns ${tag}`,
      where: { and: [{ field: "job_title", op: "eq", value: tag }, { field: "first_name", op: "eq", value: "Ann" }] }, sort: [{ field: "last_name" }] } });
    expect(view.status, JSON.stringify(view.json)).toBe(201);
    const views = await tool(c, "list_views", { object: "contact" });
    expect((views.result as { id: string; mine: boolean }[]).find((v) => v.id === view.json.data.id)).toMatchObject({ mine: true });
    const byView = await tool(c, "query_records", { view: view.json.data.id });
    expect((byView.result as { data: { last_name: string }[] }).data.map((r) => r.last_name)).toEqual(["Abe", "Zed"]);
    const appView = await asMcpProcess(t.access_token, "ops", "POST", "/v1/views", { object: "contact", name: `From the app ${tag}` });
    expect(appView.status, JSON.stringify(appView.json)).toBe(201);
    expect(appView.json.data.owner).toBe(m.id);
    expect(((await m.browser.request("GET", "/v1/views?object=contact")).json.data as { id: string }[]).map((v) => v.id)).toContain(appView.json.data.id);
    // Another member's connection doesn't see either personal view.
    const other = await member();
    const ot = await connectApp(other.browser, appA, "ops", "ops:read");
    const oc = await mcpClient("ops", ot.access_token);
    expect(((await tool(oc, "list_views", { object: "contact" })).result as { id: string }[]).map((v) => v.id)).not.toContain(view.json.data.id);
    expect((await tool(oc, "query_records", { view: view.json.data.id })).isError).toBe(true);
    await oc.close();

    // Preferences are the member's too, whichever credential reads or writes them.
    expect((await m.browser.request("PUT", "/v1/me/preferences", { body: { "ui.last_view": view.json.data.id } })).status).toBe(200);
    expect((await asMcpProcess(t.access_token, "ops", "GET", "/v1/me/preferences")).json.data).toEqual({ "ui.last_view": view.json.data.id });
    expect((await asMcpProcess(t.access_token, "ops", "PUT", "/v1/me/preferences", { "ui.density": "compact" })).status).toBe(200);
    expect((await call("GET", "/v1/me/preferences", { key: m.key })).json.data).toEqual({ "ui.last_view": view.json.data.id, "ui.density": "compact" });
    await c.close();
  });
});

describe("the write side through a connected app", () => {
  it("finds duplicates, merges (dry run, token, run), bulk-updates by filter with its token, restores, and previews a batch create", async () => {
    const m = await member();
    const t = await connectApp(m.browser, appA, "ops", "ops:read ops:write");
    const c = await mcpClient("ops", t.access_token);
    const tag = `wr${Date.now()}`;
    const email = uniqueEmail(tag);
    const survivor = await create(ws.keys.ops, "contact", { first_name: "Dee", last_name: tag, email, job_title: tag });
    const dup = await create(ws.keys.ops, "contact", { first_name: "Dee", last_name: tag, email: uniqueEmail(`${tag}b`), job_title: tag, phone: "+1 555 0100" });

    const found = await tool(c, "find_duplicates", { object: "contact", rules: [["first_name", "last_name"]] });
    expect(found.isError, found.text).toBe(false);
    const group = (found.result as { groups: { records: { id: string }[] }[] }).groups.find((g) => g.records.some((r) => r.id === survivor.id))!;
    expect(group.records.map((r) => r.id).sort()).toEqual([survivor.id, dup.id].sort());

    const dry = await tool(c, "merge_records", { survivor: survivor.id, duplicates: [dup.id] });
    expect(dry.isError, dry.text).toBe(false);
    const token = (dry.result as { confirm_token: string }).confirm_token;
    expect(token).toBeTruthy();
    expect((await tool(c, "merge_records", { survivor: survivor.id, duplicates: [dup.id], dry_run: false, confirm_token: token })).text).toMatch(/confirm must be true/);
    const merged = await tool(c, "merge_records", { survivor: survivor.id, duplicates: [dup.id], dry_run: false, confirm: true, confirm_token: token });
    expect(merged.isError, merged.text).toBe(false);
    expect((merged.result as { merged: string[] }).merged).toEqual([dup.id]);
    // Single use.
    expect((await tool(c, "merge_records", { survivor: survivor.id, duplicates: [dup.id], dry_run: false, confirm: true, confirm_token: token })).isError).toBe(true);
    // The audit entry names the connection, on the surface the token fixes.
    const [entry] = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
      return tx<{ surface: string; actor_id: string; details: Record<string, string> }[]>`
        SELECT surface, actor_id, details FROM audit_log WHERE action = 'contact.merged' AND record_id = ${uuid(survivor.id)} ORDER BY seq DESC LIMIT 1`;
    });
    expect(entry).toMatchObject({ surface: "ops-mcp", actor_id: uuid(m.id) });
    expect(entry!.details.oauth_grant).toBe(await grantOf(m.browser, appA));

    // Bulk update by filter: the dry run's token, through the same connection.
    const where = { field: "job_title", op: "eq", value: tag };
    const bulkDry = await tool(c, "bulk_update_records", { object: "contact", where, values: { lifecycle_stage: "lead" } });
    expect(bulkDry.isError, bulkDry.text).toBe(false);
    expect((bulkDry.result as { count: number }).count).toBe(1);
    const bulk = await tool(c, "bulk_update_records", { object: "contact", where, values: { lifecycle_stage: "lead" }, dry_run: false, confirm: true,
      confirm_token: (bulkDry.result as { confirm_token: string }).confirm_token });
    expect(bulk.isError, bulk.text).toBe(false);
    expect((await call("GET", `/v1/records/${survivor.id}`, { key: ws.keys.ops })).json.data.lifecycle_stage).toBe("lead");

    // Archive and restore.
    expect((await tool(c, "archive_record", { id: survivor.id, confirm: true })).isError).toBe(false);
    const archived = await tool(c, "query_records", { object: "contact", where, archived_only: true });
    // The merged duplicate is archived too.
    expect((archived.result as { data: { id: string }[] }).data.map((r) => r.id).sort()).toEqual([survivor.id, dup.id].sort());
    const restored = await tool(c, "restore_record", { id: survivor.id });
    expect(restored.isError, restored.text).toBe(false);
    expect((await call("GET", `/v1/records/${survivor.id}`, { key: ws.keys.ops })).json.data.archived_at ?? null).toBeNull();

    // A batch create's dry run writes nothing.
    const preview = await tool(c, "create_records", { object: "contact", records: [{ first_name: "P1", job_title: `${tag}p` }, { email: "not an email" }], dry_run: true });
    expect(preview.isError, preview.text).toBe(false);
    expect((preview.result as { counts: { create: number; error: number } }).counts).toEqual({ create: 1, error: 1 });
    expect((await call("POST", "/v1/query", { key: ws.keys.ops, body: { object: "contact", where: { field: "job_title", op: "eq", value: `${tag}p` }, count: true } })).json.total).toBe(0);

    // Idempotency records of these writes belong to the connection (credential 'oauth', the grant's ID).
    const rows = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${ws.tenantId}, true)`;
      return tx<{ credential: string }[]>`SELECT DISTINCT credential FROM idempotency_keys WHERE credential_id = ${uuid(await grantOf(m.browser, appA))}`;
    });
    expect(rows.map((r) => r.credential)).toEqual(["oauth"]);
    await c.close();
  });
});

describe("confirm tokens are bound to one connection", () => {
  it("a token from one connection is refused on another connection of the same member, on their API key and in their session; and the other way round", async () => {
    const m = await member();
    const [ta, tb] = [await connectApp(m.browser, appA, "ops", "ops:read ops:write"), await connectApp(m.browser, appB, "ops", "ops:read ops:write")];
    const [ca, cb] = [await mcpClient("ops", ta.access_token), await mcpClient("ops", tb.access_token)];
    const survivor = await create(ws.keys.ops, "contact", { first_name: "Tok", email: uniqueEmail("tok") });
    const dup = await create(ws.keys.ops, "contact", { first_name: "Tok", email: uniqueEmail("tokd") });
    const body = { survivor: survivor.id, duplicates: [dup.id] };
    const token = ((await tool(ca, "merge_records", body)).result as { confirm_token: string }).confirm_token;
    const real = { ...body, dry_run: false, confirm: true, confirm_token: token };

    const viaB = await tool(cb, "merge_records", real);
    expect(viaB.isError).toBe(true);
    expect(viaB.text).toMatch(/Error 400 .*another request or credential/);
    const apiBody = { ...body, dry_run: false, confirm_token: token };
    expect((await call("POST", "/v1/ops/merge_records", { key: m.key, body: apiBody })).status).toBe(400);
    expect((await m.browser.request("POST", "/v1/ops/merge_records", { body: apiBody })).status).toBe(400);
    // Refusals don't spend it: the connection that minted it applies it.
    expect((await tool(ca, "merge_records", real)).isError).toBe(false);

    // A token minted in the browser, or with the member's key, is refused through either connection.
    const s2 = await create(ws.keys.ops, "contact", { first_name: "Tok2", email: uniqueEmail("tok2") });
    const d2 = await create(ws.keys.ops, "contact", { first_name: "Tok2", email: uniqueEmail("tok2d") });
    const body2 = { survivor: s2.id, duplicates: [d2.id] };
    for (const mint of [() => m.browser.request("POST", "/v1/ops/merge_records", { body: body2 }), () => call("POST", "/v1/ops/merge_records", { key: m.key, body: body2 })]) {
      const minted = (await mint()).json.confirm_token as string;
      for (const client of [ca, cb]) {
        const r = await tool(client, "merge_records", { ...body2, dry_run: false, confirm: true, confirm_token: minted });
        expect(r.isError, r.text).toBe(true);
        expect(r.text).toMatch(/Error 400/);
      }
    }
    await ca.close();
    await cb.close();
  });

  it("disconnecting the app between the dry run and the run ends the flow; connecting it again starts a new credential", async () => {
    const m = await member();
    const t = await connectApp(m.browser, appA, "ops", "ops:read ops:write");
    const c = await mcpClient("ops", t.access_token);
    const where = { field: "job_title", op: "eq", value: `mid${Date.now()}` };
    await create(ws.keys.ops, "contact", { email: uniqueEmail("mid"), job_title: where.value });
    const dry = await tool(c, "bulk_update_records", { object: "contact", where, values: { lifecycle_stage: "customer" } });
    const token = (dry.result as { confirm_token: string }).confirm_token;
    expect((await m.browser.request("DELETE", `/v1/auth/apps/${await grantOf(m.browser, appA)}`)).status).toBe(200);
    await expect(tool(c, "bulk_update_records", { object: "contact", where, values: { lifecycle_stage: "customer" }, dry_run: false, confirm: true, confirm_token: token }))
      .rejects.toThrow();
    expect((await asMcpProcess(t.access_token, "ops", "GET", "/v1/me")).status).toBe(401);
    await c.close().catch(() => {});
    // The same app, connected again, is a new grant: the old token isn't its.
    const again = await connectApp(m.browser, appA, "ops", "ops:read ops:write");
    const c2 = await mcpClient("ops", again.access_token);
    const r = await tool(c2, "bulk_update_records", { object: "contact", where, values: { lifecycle_stage: "customer" }, dry_run: false, confirm: true, confirm_token: token });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Error 400/);
    await c2.close();
  });
});

describe("scopes through a connected app", () => {
  it("an ops:read connection is refused every write tool with a clear error; an ops connection never reaches admin tools", async () => {
    const m = await member();
    const ro = await connectApp(m.browser, appA, "ops", "ops:read");
    expect(ro.scope).toBe("ops:read");
    const c = await mcpClient("ops", ro.access_token);
    const contact = await create(ws.keys.ops, "contact", { first_name: "Ro", email: uniqueEmail("ro") });
    const dup = await create(ws.keys.ops, "contact", { first_name: "Ro", email: uniqueEmail("rod") });
    for (const [name, args] of [
      ["create_record", { object: "contact", values: { first_name: "No" } }],
      ["create_records", { object: "contact", records: [{ first_name: "No" }], dry_run: true }],
      ["update_record", { id: contact.id, values: { first_name: "No" } }],
      ["archive_record", { id: contact.id, confirm: true }],
      ["restore_record", { id: contact.id }],
      ["merge_records", { survivor: contact.id, duplicates: [dup.id] }],
      ["bulk_update_records", { object: "contact", ids: [contact.id], values: { first_name: "No" } }],
      ["bulk_archive_records", { object: "contact", ids: [contact.id] }],
    ] as const) {
      const r = await tool(c, name, args);
      expect(r.isError, `${name}: ${r.text}`).toBe(true);
      expect(r.text, name).toMatch(/Error 403 forbidden: This connected app lacks the "records:(write|archive)" permission.*"ops:write" scope/);
    }
    // Reads work.
    expect((await tool(c, "get_record", { id: contact.id })).isError).toBe(false);
    expect((await tool(c, "find_duplicates", { object: "contact" })).isError).toBe(false);
    // Admin tools: the ops server has none, and an ops token is not valid on the admin server.
    const unknown = await c.callTool({ name: "create_object", arguments: { api_name: "x" } }) as { isError?: boolean };
    expect(unknown.isError).toBe(true);
    await expect(mcpClient("admin", ro.access_token)).rejects.toThrow();
    await c.close();
    // A read-write ops connection isn't valid on the admin server either.
    const ops = await connectApp(m.browser, appB, "ops", "ops:read ops:write");
    await expect(mcpClient("admin", ops.access_token)).rejects.toThrow();
  });
});

describe("one identity per connection for the heavy-request gate and the rate limit", () => {
  it("two heavy requests per connection, the third retryable with its wait; another connection, the key and the session have their own; at most 4 across one member's apps", async () => {
    const m = await member();
    const [ta, tb] = [await connectApp(m.browser, appA, "ops", "ops:read ops:write"), await connectApp(m.browser, appB, "ops", "ops:read ops:write")];
    const [ca, cb] = [await mcpClient("ops", ta.access_token), await mcpClient("ops", tb.access_token)];
    const target = await create(ws.keys.ops, "contact", { email: uniqueEmail("gate") });
    const { released } = await holdContact(target.id, 1_500);
    const heavy = (client: typeof ca) => tool(client, "bulk_archive_records", { object: "contact", ids: [target.id], dry_run: false, confirm: true });
    const running = [heavy(ca), heavy(ca)];
    await sleep(250);
    const agg = await tool(ca, "aggregate_records", { object: "contact", group_by: [{ field: "lifecycle_stage" }] });
    expect(agg.isError).toBe(true);
    expect(agg.text).toMatch(/Error 429 too_many_heavy_requests/);
    expect(agg.text).toMatch(/Retryable: wait 1 second, then call this tool again/);
    expect(agg.meta).toEqual({ retryable: true, retry_after_seconds: 1 });
    // Ordinary calls on the same connection go through; the other connection, the key and the session each have their own slots.
    expect((await tool(ca, "get_record", { id: target.id })).isError).toBe(false);
    expect((await tool(cb, "aggregate_records", { object: "contact" })).isError).toBe(false);
    expect((await call("POST", "/v1/aggregate", { key: m.key, body: { object: "contact" } })).status).toBe(200);
    expect((await m.browser.request("POST", "/v1/aggregate", { body: { object: "contact" } })).status).toBe(200);
    await released;
    expect((await Promise.all(running)).map((r) => r.isError)).toEqual([false, false]);
    await ca.close();
    await cb.close();

    // A member's apps together: with the per-member cap at 2, two in flight on connection A leave none for connection B.
    HEAVY_LIMITS.perMemberApps = 2;
    const [ca2, cb2] = [await mcpClient("ops", ta.access_token), await mcpClient("ops", tb.access_token)];
    const t2 = await create(ws.keys.ops, "contact", { email: uniqueEmail("gate2") });
    const held = await holdContact(t2.id, 1_500);
    const running2 = [0, 1].map(() => tool(ca2, "bulk_archive_records", { object: "contact", ids: [t2.id], dry_run: false, confirm: true }));
    await sleep(250);
    const fromB = await tool(cb2, "aggregate_records", { object: "contact" });
    expect(fromB.text).toMatch(/Error 429 too_many_heavy_requests/);
    // The member's key and session are not apps.
    expect((await call("POST", "/v1/aggregate", { key: m.key, body: { object: "contact" } })).status).toBe(200);
    await held.released;
    expect((await Promise.all(running2)).map((r) => r.isError)).toEqual([false, false]);
    expect((await tool(cb2, "aggregate_records", { object: "contact" })).isError).toBe(false);
    await ca2.close();
    await cb2.close();
  });

  it("charges a connection's route costs to its own bucket, apart from the member's session and other connections", async () => {
    const m = await member();
    const [ta, tb] = [await connectApp(m.browser, appA, "ops", "ops:read ops:write"), await connectApp(m.browser, appB, "ops", "ops:read ops:write")];
    const survivor = await create(ws.keys.ops, "contact", { email: uniqueEmail("sv") });
    const dups = await Promise.all(Array.from({ length: 10 }, (_, i) => create(ws.keys.ops, "contact", { email: uniqueEmail(`dp${i}`) })));
    const body = { survivor: survivor.id, duplicates: dups.map((d) => d.id) };
    resetRateLimiter();
    // A merge dry run of 10 duplicates costs 50 tokens: four spend the burst of 200 (the MCP process's /v1/me checks take a few more), and the next waits.
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await asMcpProcess(ta.access_token, "ops", "POST", "/v1/ops/merge_records", body)).status);
    const fifth = await asMcpProcess(ta.access_token, "ops", "POST", "/v1/ops/merge_records", body);
    expect([...statuses, fifth.status]).toEqual([200, 200, 200, 200, 429]);
    expect(Number(fifth.headers.get("retry-after"))).toBeGreaterThan(0);
    // Through the MCP server, a 429 at the endpoint's own check (before any tool runs) stays a 429 with its wait, not a 502
    // (an API that answers every request with the rate limit's 429, so the bucket's refill can't make this flaky).
    const limitedApi: typeof fetch = async () => new Response(JSON.stringify({ code: "rate_limited", detail: "Too many requests for this connection; slow down" }),
      { status: 429, headers: { "Content-Type": "application/problem+json", "Retry-After": "3" } });
    const limited = await buildMcpApp({ apiUrl: "http://api.local", fetch: limitedApi, oauth: oauthSettings() }).request("https://mcp.test/mcp/ops", { method: "POST",
      headers: { Authorization: `Bearer ${ta.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3");
    expect(((await limited.json()) as { error: { message: string } }).error.message).toMatch(/retry after \d+ seconds?/i);
    // The other connection, the session and the key each have their own bucket.
    expect((await asMcpProcess(tb.access_token, "ops", "POST", "/v1/ops/merge_records", body)).status).toBe(200);
    expect((await m.browser.request("POST", "/v1/ops/merge_records", { body })).status).toBe(200);
    expect((await call("POST", "/v1/ops/merge_records", { key: m.key, body })).status).toBe(200);
  });
});

describe("rules keyed on the MCP surface hold for connected apps", () => {
  it("an admin connection can't turn on include_restricted, redirect a restricted webhook or replay its restricted deliveries", async () => {
    const b = await signedIn(ws.ownerEmail);
    const t = await connectApp(b, appA, "admin", "admin ops:read restricted:read");
    expect(t.scope).toContain("restricted:read");
    const ssn = `ssn_${Date.now()}`;
    const field = await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: ssn, type: "text", sensitivity: "restricted" } });
    expect(field.status).toBe(201);
    // Even with the surface header claimed as "api", the token's resource decides (and a mismatch is refused).
    const claimed = await app.request("/v1/me", { headers: { Authorization: `Bearer ${t.access_token}`, "X-Hlcrm-Surface": "api",
      "X-Hlcrm-Mcp-Service": oauthSettings()!.serviceSecret } });
    expect(claimed.status).toBe(401);
    const created = await asMcpProcess(t.access_token, "admin", "POST", "/v1/webhooks", { url: "https://hooks.example.com/oauth", include_restricted: true });
    expect(created.status).toBe(403);
    expect(created.json.detail).toMatch(/through the API/);
    const plain = await asMcpProcess(t.access_token, "admin", "POST", "/v1/webhooks", { url: "https://hooks.example.com/oauth-plain" });
    expect(plain.status).toBe(201);
    expect(plain.json.data.secret).toBeNull();
    expect((await asMcpProcess(t.access_token, "admin", "PATCH", `/v1/webhooks/${plain.json.data.id}`, { include_restricted: true })).status).toBe(403);

    const granted = await call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: "https://hooks.example.com/granted", events: ["contact.created"], include_restricted: true } });
    expect(granted.status).toBe(201);
    const id = granted.json.data.id as string;
    await create(ws.keys.admin, "contact", { first_name: "Res", email: uniqueEmail("res"), [ssn]: "111-22-3333" });
    await processEvents(ws.tenantId);
    for (const patch of [{ url: "https://attacker.example.com/x" }, { events: ["*"] }]) {
      const r = await asMcpProcess(t.access_token, "admin", "PATCH", `/v1/webhooks/${id}`, patch);
      expect(r.status, JSON.stringify(patch)).toBe(403);
      expect(r.json.detail).toMatch(/through the API/);
    }
    const [dlv] = (await call("GET", `/v1/webhooks/${id}/deliveries`, { key: ws.keys.admin })).json.data;
    expect(dlv).toBeTruthy();
    const admin = await mcpClient("admin", t.access_token);
    const replay = await tool(admin, "replay_webhook_delivery", { delivery: dlv.id });
    expect(replay.isError).toBe(true);
    expect(replay.text).toMatch(/Error 403 .*through the API/);
    // Keys can't be minted through MCP by a connected app either, and its owner can't change sign-in settings through it.
    expect((await asMcpProcess(t.access_token, "admin", "POST", "/v1/api-keys", { name: "from an app", scopes: ["ops:read"] })).status).toBe(400);
    const settings = await asMcpProcess(t.access_token, "admin", "PATCH", "/v1/workspace/sign-in", { password: false });
    expect(settings.status).toBe(403);
    expect(settings.json.detail).toMatch(/Connected apps can't change/);
    await admin.close();
  });
});

describe("session-only routes and connected apps", () => {
  it("refuses an app (and a key) where a session is required, and apps never manage apps", async () => {
    const m = await member();
    const t = await connectApp(m.browser, appA, "ops", "ops:read ops:write");
    const g = await grantOf(m.browser, appA);
    for (const [method, path, body] of [
      ["GET", "/v1/auth/session", undefined], ["GET", "/v1/auth/sessions", undefined], ["POST", "/v1/auth/sessions/revoke-others", undefined],
      ["POST", "/v1/auth/password", { password: "Correct horse battery staple 1" }], ["DELETE", "/v1/auth/password", undefined], ["DELETE", "/v1/auth/sso", undefined],
      ["GET", "/v1/auth/apps", undefined], ["DELETE", `/v1/auth/apps/${g}`, undefined], ["POST", "/v1/auth/sign-out", undefined],
    ] as const) {
      const viaApp = await asMcpProcess(t.access_token, "ops", method, path, body);
      expect(viaApp.status, `${method} ${path}`).toBe(403);
      expect(viaApp.json.detail).toMatch(/not an API key or a connected app/);
      expect((await call(method, path, { key: m.key, body })).status, `${method} ${path} with a key`).toBe(403);
    }
    for (const [method, path] of [["GET", "/v1/apps"], ["DELETE", `/v1/apps/${g}`]] as const) {
      const r = await asMcpProcess(t.access_token, "ops", method, path);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.json.detail).toMatch(/Connected apps can't list or disconnect apps/);
    }
    // Still connected, and still listed for the member's key and session.
    expect((await asMcpProcess(t.access_token, "ops", "GET", "/v1/me")).status).toBe(200);
    expect((await call("GET", "/v1/apps", { key: m.key })).json.data.map((x: { id: string }) => x.id)).toEqual([g]);
  });
});

describe("declared responses of the connected-apps routes", () => {
  it("match what the routes return, and the public document describes OAuth without implying /v1 takes its tokens", async () => {
    const m = await member();
    await connectApp(m.browser, appA, "ops", "ops:read ops:write");
    await connectApp(m.browser, appB, "ops", "ops:read");
    const doc = (await call("GET", "/v1/openapi.json", { key: ws.keys.admin })).json as Schema;
    const paths = doc.paths as Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: Schema }> }> }>>;
    const [g1, g2] = ((await m.browser.request("GET", "/v1/auth/apps")).json.data as { id: string }[]).map((x) => x.id);
    const samples: [string, string, () => Promise<{ status: number; json: unknown }>][] = [
      ["GET", "/v1/auth/apps", () => m.browser.request("GET", "/v1/auth/apps")],
      ["GET", "/v1/apps", () => call("GET", "/v1/apps", { key: m.key })],
      ["GET", "/v1/apps", () => call("GET", `/v1/apps?member=${m.id}`, { key: ws.keys.admin })],
      ["DELETE", "/v1/auth/apps/{id}", () => m.browser.request("DELETE", `/v1/auth/apps/${g1}`)],
      ["DELETE", "/v1/apps/{id}", () => call("DELETE", `/v1/apps/${g2}`, { key: ws.keys.admin })],
      ["PATCH", "/v1/workspace/sign-in", () => call("PATCH", "/v1/workspace/sign-in", { key: ws.keys.admin, body: { oauth_scopes: ["ops:read", "ops:write", "restricted:read", "admin"] } })],
    ];
    samples.push(["POST", "/v1/members/{id}/sessions/revoke", () => call("POST", `/v1/members/${m.id}/sessions/revoke`, { key: ws.keys.admin })]);
    for (const [method, template, run] of samples) {
      const res = await run();
      expect(res.status, `${method} ${template}: ${JSON.stringify(res.json)}`).toBe(200);
      const declared = paths[template]![method.toLowerCase()]!.responses["200"]!.content["application/json"]!.schema;
      expect(validate(doc, declared, res.json), `${method} ${template}`).toEqual([]);
    }
    expect(validate(doc, { $ref: "#/components/schemas/ConnectedApp" }, { id: "ogr_x", token: "x" }).length).toBeGreaterThan(0);
    // revoke-others answers with apps_revoked, in its closed shape.
    const b2 = await signedIn(m.email);
    await connectApp(b2, appA, "ops", "ops:read");
    const others = await b2.request("POST", "/v1/auth/sessions/revoke-others");
    expect(others.json).toEqual({ revoked: expect.any(Number), apps_revoked: 1 });
    expect(validate(doc, paths["/v1/auth/sessions/revoke-others"]!.post!.responses["200"]!.content["application/json"]!.schema, others.json)).toEqual([]);

    // The OAuth scheme is described, no operation lists it, and the public document has no /oauth or well-known paths.
    for (const d of [doc, await (await app.request("/openapi.json")).json() as Schema]) {
      const schemes = (d.components as { securitySchemes: Record<string, { type: string; description: string }> }).securitySchemes;
      expect(Object.keys(schemes).sort()).toEqual(["bearer", "mcpOAuth", "session"]);
      expect(schemes.mcpOAuth!.type).toBe("oauth2");
      expect(schemes.mcpOAuth!.description).toMatch(/does not accept these tokens/);
      expect(JSON.stringify(d.paths)).not.toContain("mcpOAuth");
      expect(Object.keys(d.paths as Schema).filter((p) => p.startsWith("/oauth") || p.startsWith("/.well-known") || p.startsWith("/auth"))).toEqual([]);
    }
  });
});
