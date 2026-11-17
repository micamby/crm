import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fillTemplates, MAX_DEPTH } from "../src/core/automations.js";
import { matchesPattern, MAX_ATTEMPTS, recordAttempt, sign, verify } from "../src/core/webhooks.js";
import { withTenant } from "../src/db/tx.js";
import { decodeId } from "../src/lib/ids.js";
import { blockedReason, BlockedTargetError, checkUrl, resolveTarget } from "../src/lib/outbound.js";
import { deliverDue, processEvents } from "../src/worker/events.js";
import { call, create, newWorkspace, type Workspace } from "./helpers.js";

// Tests deliver to a local HTTP receiver, which needs the self-hosted "insecure targets" switch.
// The default (off) policy is covered by the unit tests below.
process.env.WEBHOOK_ALLOW_INSECURE_TARGETS = "true";

interface Received { headers: IncomingMessage["headers"]; body: string; path: string }
let server: Server;
let base = "";
const received: Received[] = [];
let failNext = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body, path: req.url ?? "" });
      if (failNext > 0) {
        failNext--;
        res.writeHead(500).end("receiver down");
      } else res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const forPath = (p: string) => received.filter((r) => r.path === p);
const uniq = (s: string) => `${s}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** Runs the worker passes the way the worker loop does, until nothing is left. */
async function drain(ws: Workspace) {
  for (let i = 0; i < 20; i++) {
    const n = (await processEvents(ws.tenantId)) + (await deliverDue(ws.tenantId));
    if (n === 0) return;
  }
}

async function makeDue(ws: Workspace) {
  await withTenant(ws.tenantId, (tx) => tx`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE status = 'pending'`);
}

describe("SSRF guard", () => {
  const strict = { allowInsecure: false };
  it("blocks private, loopback, link-local, CGNAT and metadata addresses, including IPv4 inside IPv6", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.5.4", "192.168.1.1", "100.64.0.1", "169.254.169.254", "0.0.0.0",
      "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::a9fe:a9fe", "fd00:ec2::254"]) {
      expect(blockedReason(a, false), a).not.toBeNull();
    }
    expect(blockedReason("93.184.216.34", false)).toBeNull();
    expect(blockedReason("2606:4700:4700::1111", false)).toBeNull();
  });

  it("blocks every special-purpose range (RFC 6890 and the IANA registries), in any IPv6 spelling", () => {
    const blocked = [
      // IPv4
      "0.1.2.3", "10.255.0.1", "100.127.255.254", "127.8.8.8", "169.254.1.1", "172.31.0.1", "192.0.0.8", "192.0.2.1",
      "192.31.196.1", "192.52.193.1", "192.88.99.1", "192.168.255.255", "192.175.48.1", "198.19.0.1", "198.51.100.7",
      "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
      // IPv6
      "::", "::1", "::127.0.0.1", "::7f00:1", "::a9fe:a9fe", "::8.8.8.8", "::ffff:0:7f00:1", "::ffff:0:808:808",
      "0:0:0:0:0:ffff:7f00:1", "0:0:0:0:0:ffff:127.0.0.1", "64:ff9b::7f00:1", "64:ff9b:1::1", "64:ff9b:1::808:808",
      "100::1", "100:0:0:1::1", "2001::1", "2001:2::1", "2001:10::1", "2001:20::1", "2001:db8::1", "3fff::1", "2002:808:808::1",
      "2620:4f:8000::1", "5f00::1", "fc00::1", "fd12:3456::1", "fe80::1%en0", "fec0::1", "ff02::1",
    ];
    for (const a of blocked) expect(blockedReason(a, false), a).not.toBeNull();
    // Public addresses, including public IPv4 reached through mapped and well-known NAT64 forms.
    for (const a of ["8.8.8.8", "1.1.1.1", "::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::808:808", "2606:4700::1111", "2a00:1450::1"]) {
      expect(blockedReason(a, false), a).toBeNull();
    }
    // Metadata stays blocked through every embedding, even with private targets allowed.
    for (const a of ["::169.254.169.254", "::a9fe:a9fe", "::ffff:0:a9fe:a9fe", "0:0:0:0:0:ffff:a9fe:a9fe", "64:ff9b::169.254.169.254"]) {
      expect(blockedReason(a, true), a).toMatch(/metadata/);
    }
    expect(() => checkUrl("https://[::127.0.0.1]/hook", strict)).toThrow(/blocked/);
    expect(() => checkUrl("https://[64:ff9b:1::a9fe:a9fe]/hook", strict)).toThrow(/blocked/);
  });

  it("keeps metadata addresses blocked even when private targets are allowed", () => {
    expect(blockedReason("10.0.0.5", true)).toBeNull();
    expect(blockedReason("169.254.169.254", true)).toMatch(/metadata/);
    expect(blockedReason("::ffff:169.254.169.254", true)).toMatch(/metadata/);
    expect(blockedReason("fd00:ec2::254", true)).toMatch(/metadata/);
  });

  it("requires https, no credentials and no internal host names", () => {
    expect(() => checkUrl("http://example.com/hook", strict)).toThrow(BlockedTargetError);
    expect(() => checkUrl("https://user:pw@example.com/hook", strict)).toThrow(/credentials/);
    expect(() => checkUrl("https://localhost/hook", strict)).toThrow(/internal/);
    expect(() => checkUrl("https://[::1]/hook", strict)).toThrow(/blocked/);
    expect(() => checkUrl("https://169.254.169.254/latest/meta-data", { allowInsecure: true })).toThrow(/metadata/);
    expect(checkUrl("https://hooks.example.com/x", strict).hostname).toBe("hooks.example.com");
  });

  it("re-checks after DNS resolution", async () => {
    await expect(resolveTarget(new URL("https://localhost./x"), strict)).rejects.toThrow(/blocked|resolve/);
  });

  it("refuses a metadata URL at registration, whatever the deployment allows", async () => {
    const ws = await newWorkspace("SSRF");
    const r = await call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: "http://169.254.169.254/latest/meta-data/" } });
    expect(r.status).toBe(422);
    expect(r.json.detail).toMatch(/metadata/);
  });
});

describe("signatures and helpers", () => {
  const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
  it("verifies Standard Webhooks signatures and rejects tampering and stale timestamps", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = sign(secret, "dlv_1", ts, '{"a":1}');
    expect(verify(secret, { id: "dlv_1", timestamp: String(ts), signature: sig }, '{"a":1}')).toBe(true);
    expect(verify(secret, { id: "dlv_1", timestamp: String(ts), signature: sig }, '{"a":2}')).toBe(false);
    expect(verify(secret, { id: "dlv_2", timestamp: String(ts), signature: sig }, '{"a":1}')).toBe(false);
    const old = ts - 600;
    expect(verify(secret, { id: "dlv_1", timestamp: String(old), signature: sign(secret, "dlv_1", old, "{}") }, "{}")).toBe(false);
  });

  it("matches subscription patterns", () => {
    expect(matchesPattern("*", "deal.created")).toBe(true);
    expect(matchesPattern("deal.*", "deal.stage_changed")).toBe(true);
    expect(matchesPattern("*.created", "contact.created")).toBe(true);
    expect(matchesPattern("deal.*", "dealer.created")).toBe(false);
    expect(matchesPattern("contact.created", "contact.updated")).toBe(false);
  });

  it("fills templates, keeping types for whole-value placeholders", () => {
    const out = fillTemplates(
      { title: "Follow up with {{record.name}}", related_to: ["{{record.id}}"], amount: "{{record.amount}}", due: "{{today+3d}}" },
      { record: { id: "deal_X", object: "deal", name: "Big", amount: 5000 }, event: { type: "deal.created", id: "evt_1" } },
    );
    expect(out).toMatchObject({ title: "Follow up with Big", related_to: ["deal_X"], amount: 5000 });
    expect(out.due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(() => fillTemplates({ x: "{{secret.thing}}" }, { record: null, event: { type: "t", id: "e" } })).toThrow(/placeholder/);
  });
});

describe("automation that fires a signed webhook (definition of done)", () => {
  let ws: Workspace;
  let hookId = "";
  let secret = "";
  let autoId = "";
  let contactId = "";

  beforeAll(async () => {
    ws = await newWorkspace("Automations");
    contactId = (await create(ws.keys.ops, "contact", { first_name: "Dee", email: `${uniq("dee")}@example.com` })).id;
  });

  it("registers a webhook and returns its secret once over the API, never over MCP", async () => {
    const r = await call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: `${base}/big-deals`, description: "Big deals" } });
    expect(r.status).toBe(201);
    expect(r.json.data.secret).toMatch(/^whsec_/);
    hookId = r.json.data.id;
    secret = r.json.data.secret;
    const list = await call("GET", "/v1/webhooks", { key: ws.keys.admin });
    expect(JSON.stringify(list.json)).not.toContain(secret);
    const viaMcp = await call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: `${base}/other` }, headers: { "X-HLCRM-Surface": "admin-mcp" } });
    expect(viaMcp.json.data.secret).toBeNull();
    const reveal = await call("GET", `/v1/webhooks/${hookId}/secret`, { key: ws.keys.admin, headers: { "X-HLCRM-Surface": "admin-mcp" } });
    expect(reveal.status).toBe(400);
    expect((await call("GET", `/v1/webhooks/${hookId}/secret`, { key: ws.keys.admin })).json.data.secret).toBe(secret);
  });

  it("ops keys and the ops surface cannot create automations or webhooks", async () => {
    const body = { name: "x", trigger: { event: "deal.created" }, actions: [{ type: "send_webhook", webhook: hookId }] };
    expect((await call("POST", "/v1/automations", { key: ws.keys.ops, body })).status).toBe(403);
    expect((await call("POST", "/v1/automations", { key: ws.keys.admin, body, headers: { "X-HLCRM-Surface": "ops-mcp" } })).status).toBe(403);
    expect((await call("POST", "/v1/webhooks", { key: ws.keys.ops, body: { url: `${base}/x` } })).status).toBe(403);
  });

  it("dry run explains the rule in plain language and saves nothing", async () => {
    const r = await call("POST", "/v1/automations", { key: ws.keys.admin, body: {
      name: "Notify on big deals", trigger: { event: "deal.created" },
      condition: { field: "amount", op: "gt", value: 10000 },
      actions: [{ type: "send_webhook", webhook: hookId }], dry_run: true,
    } });
    expect(r.status).toBe(200);
    expect(r.json.dry_run).toBe(true);
    expect(r.json.summary).toContain("When a deal is created");
    expect(r.json.summary).toContain(`${base}/big-deals`);
    expect((await call("GET", "/v1/automations", { key: ws.keys.admin })).json.data).toEqual([]);
  });

  it("rejects invalid rules with a clear message", async () => {
    const bad = async (body: unknown) => (await call("POST", "/v1/automations", { key: ws.keys.admin, body })).json.detail as string;
    expect(await bad({ name: "x", trigger: { event: "deal.exploded" }, actions: [{ type: "send_webhook", webhook: hookId }] })).toMatch(/Unknown trigger/);
    expect(await bad({ name: "x", trigger: { event: "deal.created" }, condition: { field: "nope", op: "eq", value: 1 }, actions: [{ type: "send_webhook", webhook: hookId }] })).toMatch(/condition/);
    expect(await bad({ name: "x", trigger: { event: "deal.created" }, actions: [{ type: "update_record", values: { nope: 1 } }] })).toMatch(/not a field/);
    expect(await bad({ name: "x", trigger: { event: "deal.created" }, actions: [{ type: "update_record", values: { stage: "Won" } }] })).toMatch(/only be set/);
    expect(await bad({ name: "x", trigger: { event: "deal.created" }, actions: [{ type: "send_webhook", webhook: "whk_00000000000000000000000000" }] })).toMatch(/not found/);
  });

  it("saves, and test_automation shows the payload for a real record without sending or changing anything", async () => {
    const r = await call("POST", "/v1/automations", { key: ws.keys.admin, body: {
      name: "Notify on big deals", trigger: { event: "deal.created" }, condition: { field: "amount", op: "gt", value: 10000 },
      actions: [{ type: "send_webhook", webhook: hookId }, { type: "create_record", object: "task", values: { title: "Call about {{record.name}}", related_to: ["{{record.id}}"], assignee: "{{record.owner}}", due_at: "{{today+2d}}" } }],
    } });
    expect(r.status).toBe(201);
    autoId = r.json.automation.id;
    await drain(ws); // nothing pending yet
    const small = await create(ws.keys.ops, "deal", { name: "Small one", amount: 500, primary_contact: contactId });
    const big = await create(ws.keys.ops, "deal", { name: "Big one", amount: 50000, primary_contact: contactId });
    const before = received.length;
    const tSmall = await call("POST", `/v1/automations/${autoId}/test`, { key: ws.keys.admin, body: { record: small.id } });
    expect(tSmall.json.data.matched).toBe(false);
    const tBig = await call("POST", `/v1/automations/${autoId}/test`, { key: ws.keys.admin, body: { record: big.id } });
    expect(tBig.json.data.matched).toBe(true);
    expect(tBig.json.data.actions[0].detail.payload.record.name).toBe("Big one");
    expect(tBig.json.data.actions[1].detail.result.title).toBe("Call about Big one");
    expect(received.length).toBe(before);
    const tasks = await call("POST", "/v1/query", { key: ws.keys.ops, body: { object: "task", where: { field: "title", op: "starts_with", value: "Call about" } } });
    expect(tasks.json.data).toEqual([]);
  });

  it("fires once for a matching record, signed, and the receiver can verify it", async () => {
    await drain(ws); // the two deals from the previous test
    const hits = forPath("/big-deals");
    expect(hits).toHaveLength(1);
    const h = hits[0]!;
    expect(verify(secret, { id: h.headers["webhook-id"] as string, timestamp: h.headers["webhook-timestamp"] as string, signature: h.headers["webhook-signature"] as string }, h.body)).toBe(true);
    const payload = JSON.parse(h.body);
    expect(payload).toMatchObject({ type: "deal.created", object: "deal", record: { name: "Big one", amount: 50000, primary_contact: contactId }, automation: { id: autoId } });
    expect(payload.id).toMatch(/^evt_/);
    const tasks = await call("POST", "/v1/query", { key: ws.keys.ops, body: { object: "task", where: { field: "title", op: "eq", value: "Call about Big one" } } });
    expect(tasks.json.data).toHaveLength(1);
    const runs = await call("GET", `/v1/automations/${autoId}/runs`, { key: ws.keys.admin });
    expect(runs.json.data.map((x: { status: string }) => x.status)).toEqual(["succeeded"]);
    // Re-running the worker changes nothing.
    await drain(ws);
    expect(forPath("/big-deals")).toHaveLength(1);
  });

  it("the task it created records the automation as the actor", async () => {
    const ev = await call("GET", "/v1/events?type=task.created", { key: ws.keys.ops });
    expect(ev.json.data[0].actor).toMatchObject({ type: "automation", id: autoId, surface: "automation" });
    expect(ev.json.data[0].causation_depth).toBe(1);
  });

  it("retries with backoff, dead-letters after the last attempt, and can be replayed", async () => {
    // The receiver answers 500 with the body "receiver down": the log keeps the status, never the body.
    failNext = MAX_ATTEMPTS;
    await create(ws.keys.ops, "deal", { name: "Flaky", amount: 99999, primary_contact: contactId });
    await processEvents(ws.tenantId);
    await deliverDue(ws.tenantId);
    let log = await call("GET", `/v1/webhooks/${hookId}/deliveries?status=pending`, { key: ws.keys.admin });
    expect(log.json.data).toHaveLength(1);
    const d = log.json.data[0];
    expect(d.attempts).toBe(1);
    expect(d.last_status_code).toBe(500);
    expect(d.last_error).toBe("HTTP 500");
    expect(new Date(d.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 20_000);
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await makeDue(ws);
      await deliverDue(ws.tenantId);
    }
    log = await call("GET", `/v1/webhooks/${hookId}/deliveries?status=dead`, { key: ws.keys.admin });
    expect(log.json.data[0]).toMatchObject({ id: d.id, status: "dead", attempts: MAX_ATTEMPTS });
    const replay = await call("POST", `/v1/webhook-deliveries/${d.id}/replay`, { key: ws.keys.admin });
    expect(replay.status).toBe(202);
    await deliverDue(ws.tenantId);
    const after = await call("GET", `/v1/webhook-deliveries/${replay.json.data.id}`, { key: ws.keys.admin });
    expect(after.json.data).toMatchObject({ status: "succeeded", replay_of: d.id });
    expect(JSON.parse(forPath("/big-deals").at(-1)!.body).record.name).toBe("Flaky");
  });

  it("sends a backlog in order, several per endpoint per pass", async () => {
    const hook = await call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: `${base}/burst`, events: ["account.created"] } });
    expect(hook.status).toBe(201);
    for (let i = 0; i < 12; i++) await create(ws.keys.ops, "account", { name: `Burst ${i}` });
    await processEvents(ws.tenantId);
    expect(await deliverDue(ws.tenantId)).toBe(5);
    await drain(ws);
    expect(forPath("/burst").map((r) => JSON.parse(r.body).record.name)).toEqual(Array.from({ length: 12 }, (_, i) => `Burst ${i}`));
  });

  it("rotation signs with both secrets during the overlap", async () => {
    const r = await call("POST", `/v1/webhooks/${hookId}/rotate-secret`, { key: ws.keys.admin, body: { overlap_hours: 1 } });
    const fresh = r.json.data.secret as string;
    expect(fresh).not.toBe(secret);
    const before = forPath("/big-deals").length;
    const t = await call("POST", `/v1/webhooks/${hookId}/test`, { key: ws.keys.admin });
    // Queued, not sent from the request: the API holds a transaction open while a handler runs.
    expect(t.status).toBe(202);
    expect(t.json.data.delivery).toMatchObject({ status: "pending", trigger: "test", event_type: "webhook.test" });
    expect(forPath("/big-deals")).toHaveLength(before);
    await deliverDue(ws.tenantId);
    const sent = await call("GET", t.json.data.poll, { key: ws.keys.admin });
    expect(sent.json.data).toMatchObject({ status: "succeeded", attempts: 1, last_status_code: 204 });
    const h = forPath("/big-deals").at(-1)!;
    const hdr = { id: h.headers["webhook-id"] as string, timestamp: h.headers["webhook-timestamp"] as string, signature: h.headers["webhook-signature"] as string };
    expect(hdr.signature.split(" ")).toHaveLength(2);
    expect(verify(fresh, hdr, h.body)).toBe(true);
    expect(verify(secret, hdr, h.body)).toBe(true);
  });
});

describe("subscriptions and restricted data", () => {
  let ws: Workspace;
  beforeAll(async () => {
    ws = await newWorkspace("Subscriptions");
    const r = await call("POST", "/v1/objects/contact/fields", { key: ws.keys.admin, body: { api_name: "ssn", type: "text", sensitivity: "restricted" } });
    expect(r.status).toBe(201);
  });

  it("redacts restricted values unless the endpoint is granted them, and never stores them in the log", async () => {
    const plain = await call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: `${base}/plain`, events: ["contact.created"] } });
    const granted = await call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: `${base}/granted`, events: ["contact.*"], include_restricted: true } });
    expect(granted.json.data.include_restricted).toBe(true);
    await create(ws.keys.admin, "contact", { first_name: "Rita", email: `${uniq("rita")}@example.com`, ssn: "123-45-6789" });
    await drain(ws);
    expect(JSON.parse(forPath("/plain").at(-1)!.body).record.ssn).toBe("[restricted]");
    expect(JSON.parse(forPath("/granted").at(-1)!.body).record.ssn).toBe("123-45-6789");
    for (const id of [plain.json.data.id, granted.json.data.id]) {
      const log = await call("GET", `/v1/webhooks/${id}/deliveries`, { key: ws.keys.admin });
      expect(JSON.stringify(log.json)).not.toContain("123-45-6789");
    }
    const rows = await withTenant(ws.tenantId, (tx) => tx`SELECT payload::text AS p FROM webhook_deliveries`);
    expect(rows.map((r) => r.p).join("")).not.toContain("123-45-6789");
  });

  it("only a key with restricted:read can grant restricted values", async () => {
    const k = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "admin only", scopes: ["admin"] } });
    const r = await call("POST", "/v1/webhooks", { key: k.json.data.secret, body: { url: `${base}/x`, include_restricted: true } });
    expect(r.status).toBe(403);
  });

  it("a key without restricted:read cannot redirect or replay restricted values", async () => {
    const k = await call("POST", "/v1/api-keys", { key: ws.keys.admin, body: { name: "admin, no restricted", scopes: ["admin"] } });
    const noRestricted = k.json.data.secret as string;
    const hook = await call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: `${base}/granted-2`, events: ["contact.created"], include_restricted: true } });
    const id = hook.json.data.id as string;
    await create(ws.keys.admin, "contact", { first_name: "Sam", email: `${uniq("sam")}@example.com`, ssn: "987-65-4321" });
    await drain(ws);
    expect(JSON.parse(forPath("/granted-2").at(-1)!.body).record.ssn).toBe("987-65-4321");

    const patch = (body: unknown, key = noRestricted) => call("PATCH", `/v1/webhooks/${id}`, { key, body });
    expect((await patch({ url: `${base}/attacker` })).status).toBe(403);
    expect((await patch({ events: ["contact.*"] })).status).toBe(403);
    expect((await patch({ url: `${base}/granted-2`, description: "same URL is fine" })).status).toBe(200);
    expect((await call("GET", `/v1/webhooks/${id}`, { key: ws.keys.admin })).json.data.url).toBe(`${base}/granted-2`);

    const [dlv] = (await call("GET", `/v1/webhooks/${id}/deliveries`, { key: ws.keys.admin })).json.data;
    const replay = await call("POST", `/v1/webhook-deliveries/${dlv.id}/replay`, { key: noRestricted });
    expect(replay.status).toBe(403);
    expect(replay.json.detail).toMatch(/restricted:read/);
    expect((await call("POST", `/v1/webhook-deliveries/${dlv.id}/replay`, { key: ws.keys.admin })).status).toBe(202);

    // Turning the grant off needs nothing; after that the URL is no longer guarded.
    expect((await patch({ include_restricted: false })).status).toBe(200);
    expect((await patch({ url: `${base}/elsewhere` })).status).toBe(200);
    // A key with restricted:read may change a granted endpoint.
    expect((await patch({ include_restricted: true, url: `${base}/granted-2` }, ws.keys.admin)).status).toBe(200);
    expect((await patch({ events: ["contact.*"] }, ws.keys.admin)).status).toBe(200);
  });

  it("include_restricted cannot be turned on through MCP", async () => {
    const mcp = { "X-HLCRM-Surface": "admin-mcp" };
    const created = await call("POST", "/v1/webhooks", { key: ws.keys.admin, headers: mcp, body: { url: `${base}/mcp`, include_restricted: true } });
    expect(created.status).toBe(403);
    expect(created.json.detail).toMatch(/through the API/);
    const plain = await call("POST", "/v1/webhooks", { key: ws.keys.admin, headers: mcp, body: { url: `${base}/mcp` } });
    expect(plain.status).toBe(201);
    const on = await call("PATCH", `/v1/webhooks/${plain.json.data.id}`, { key: ws.keys.admin, headers: mcp, body: { include_restricted: true } });
    expect(on.status).toBe(403);
    expect(on.json.detail).toMatch(/through the API/);
    expect((await call("PATCH", `/v1/webhooks/${plain.json.data.id}`, { key: ws.keys.admin, body: { include_restricted: true } })).status).toBe(200);
  });

  it("through MCP, a webhook with restricted values can't be redirected and its restricted deliveries can't be replayed", async () => {
    const mcp = { "X-HLCRM-Surface": "admin-mcp" };
    const hook = await call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: `${base}/granted-mcp`, events: ["contact.created"], include_restricted: true } });
    const id = hook.json.data.id as string;
    await create(ws.keys.admin, "contact", { first_name: "Mia", email: `${uniq("mia")}@example.com`, ssn: "111-22-3333" });
    await drain(ws);
    // ws.keys.admin holds restricted:read, so only the surface stops these.
    for (const body of [{ url: `${base}/attacker` }, { events: ["*"] }, { url: `${base}/attacker`, include_restricted: true }]) {
      const r = await call("PATCH", `/v1/webhooks/${id}`, { key: ws.keys.admin, headers: mcp, body });
      expect(r.status, JSON.stringify(body)).toBe(403);
      expect(r.json.detail).toMatch(/through the API/);
    }
    expect((await call("PATCH", `/v1/webhooks/${id}`, { key: ws.keys.admin, headers: mcp, body: { description: "fine" } })).status).toBe(200);
    expect((await call("GET", `/v1/webhooks/${id}`, { key: ws.keys.admin })).json.data.url).toBe(`${base}/granted-mcp`);
    const [dlv] = (await call("GET", `/v1/webhooks/${id}/deliveries`, { key: ws.keys.admin })).json.data;
    const replay = await call("POST", `/v1/webhook-deliveries/${dlv.id}/replay`, { key: ws.keys.admin, headers: mcp });
    expect(replay.status).toBe(403);
    expect(replay.json.detail).toMatch(/through the API/);
    expect((await call("POST", `/v1/webhook-deliveries/${dlv.id}/replay`, { key: ws.keys.admin })).status).toBe(202);
    // Turning the grant off through MCP is allowed, and with it off the URL is no longer guarded.
    expect((await call("PATCH", `/v1/webhooks/${id}`, { key: ws.keys.admin, headers: mcp, body: { include_restricted: false, url: `${base}/plain-now` } })).status).toBe(200);
  });
});

describe("test deliveries", () => {
  it("are sent by the worker even to a disabled endpoint, and a failure is final after one attempt", async () => {
    const ws = await newWorkspace("Tests");
    const hook = await call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: `${base}/tests`, enabled: false } });
    const ok = await call("POST", `/v1/webhooks/${hook.json.data.id}/test`, { key: ws.keys.admin });
    await deliverDue(ws.tenantId);
    expect((await call("GET", ok.json.data.poll, { key: ws.keys.admin })).json.data).toMatchObject({ status: "succeeded" });
    failNext = 1;
    const bad = await call("POST", `/v1/webhooks/${hook.json.data.id}/test`, { key: ws.keys.admin });
    await deliverDue(ws.tenantId);
    expect((await call("GET", bad.json.data.poll, { key: ws.keys.admin })).json.data)
      .toMatchObject({ status: "dead", attempts: 1, last_status_code: 500, last_error: "HTTP 500" });
  });

  it("failed tests don't count against real deliveries or open the circuit breaker", async () => {
    const ws = await newWorkspace("Test failures");
    const hook = await call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: `${base}/test-failures` } });
    const w = { id: decodeId(hook.json.data.id)!.uuid };
    const t = await call("POST", `/v1/webhooks/${hook.json.data.id}/test`, { key: ws.keys.admin });
    const row = { id: decodeId(t.json.data.delivery.id)!.uuid, attempts: 0, consumer: `test:${decodeId(t.json.data.delivery.id)!.uuid}` };
    const failed = { ok: false, status: 500, error: "HTTP 500", code: "http_status", durationMs: 1 };
    // More failed tests than the circuit threshold (10).
    for (let i = 0; i < 12; i++) await withTenant(ws.tenantId, (tx) => recordAttempt(tx, w, row, failed));
    expect((await call("GET", `/v1/webhooks/${hook.json.data.id}`, { key: ws.keys.admin })).json.data)
      .toMatchObject({ consecutive_failures: 0, status: "active", paused_until: null });
    // A real delivery's failure still counts.
    await withTenant(ws.tenantId, (tx) => recordAttempt(tx, w, { ...row, consumer: "subscription" }, failed));
    expect((await call("GET", `/v1/webhooks/${hook.json.data.id}`, { key: ws.keys.admin })).json.data.consecutive_failures).toBe(1);
  });

  it("the pending-test cap holds under concurrent requests", async () => {
    const ws = await newWorkspace("Test cap");
    const hook = await call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: `${base}/test-cap` } });
    const results = await Promise.all(Array.from({ length: 8 }, () => call("POST", `/v1/webhooks/${hook.json.data.id}/test`, { key: ws.keys.admin })));
    expect(results.filter((r) => r.status === 202)).toHaveLength(5);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    const [n] = await withTenant(ws.tenantId, (tx) => tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM webhook_deliveries WHERE consumer LIKE 'test:%' AND status = 'pending'`);
    expect(n!.n).toBe(5);
  });

  it("a worker whose lease was taken over cannot record an outcome", async () => {
    const ws = await newWorkspace("Lease");
    const hook = await call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: `${base}/lease` } });
    const t = await call("POST", `/v1/webhooks/${hook.json.data.id}/test`, { key: ws.keys.admin });
    const id = decodeId(t.json.data.delivery.id)!.uuid;
    const mine = "00000000-0000-4000-8000-000000000001";
    const theirs = "00000000-0000-4000-8000-000000000002";
    await withTenant(ws.tenantId, (tx) => tx`UPDATE webhook_deliveries SET status = 'sending', lease_token = ${theirs} WHERE id = ${id}`);
    const out = { ok: true, status: 204, error: null, code: null, durationMs: 1 };
    const row = { id, attempts: 0, consumer: `test:${id}` };
    const w = { id: decodeId(hook.json.data.id)!.uuid };
    expect(await withTenant(ws.tenantId, (tx) => recordAttempt(tx, w, row, out, mine))).toBe(false);
    expect((await call("GET", t.json.data.poll, { key: ws.keys.admin })).json.data.status).toBe("pending");
    expect(await withTenant(ws.tenantId, (tx) => recordAttempt(tx, w, row, out, theirs))).toBe(true);
    expect((await call("GET", t.json.data.poll, { key: ws.keys.admin })).json.data.status).toBe("succeeded");
  });
});

describe("loop protection", () => {
  it("two automations that trigger each other stop at the depth limit", async () => {
    const ws = await newWorkspace("Loops");
    const mk = (name: string, field: string) => call("POST", "/v1/automations", { key: ws.keys.admin, body: {
      name, trigger: { event: "contact.updated" }, actions: [{ type: "update_record", values: { [field]: `{{record.${field === "job_title" ? "last_name" : "job_title"}}}x` } }],
    } });
    expect((await mk("A", "job_title")).status).toBe(201);
    const b = await mk("B", "last_name");
    expect(b.status).toBe(201);
    const c = await create(ws.keys.ops, "contact", { first_name: "Loop", last_name: "L", email: `${uniq("loop")}@example.com` });
    await call("PATCH", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops, body: { job_title: "start" } });
    await drain(ws);
    const runs = await call("GET", `/v1/automations/${b.json.automation.id}/runs`, { key: ws.keys.admin });
    const statuses = runs.json.data.map((r: { status: string }) => r.status);
    expect(statuses).toContain("skipped");
    expect(runs.json.data.find((r: { status: string }) => r.status === "skipped").reason).toMatch(/depth/);
    const events = await call("GET", `/v1/events?record=${c.id}&limit=200`, { key: ws.keys.ops });
    expect(Math.max(...events.json.data.map((e: { causation_depth: number }) => e.causation_depth))).toBe(MAX_DEPTH);
  });

  it("an automation never re-triggers itself", async () => {
    const ws = await newWorkspace("Self");
    const a = await call("POST", "/v1/automations", { key: ws.keys.admin, body: {
      name: "Stamp", trigger: { event: "contact.updated" }, actions: [{ type: "update_record", values: { job_title: "stamped" } }],
    } });
    const c = await create(ws.keys.ops, "contact", { first_name: "Self", email: `${uniq("self")}@example.com` });
    await call("PATCH", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops, body: { last_name: "Changed" } });
    await drain(ws);
    const runs = await call("GET", `/v1/automations/${a.json.automation.id}/runs`, { key: ws.keys.admin });
    expect(runs.json.data).toHaveLength(1);
  });

  it("respects changed_fields and the hourly cap", async () => {
    const ws = await newWorkspace("Cap");
    const hook = await call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: `${base}/cap` } });
    const a = await call("POST", "/v1/automations", { key: ws.keys.admin, body: {
      name: "Title watch", trigger: { event: "contact.updated", changed_fields: ["job_title"] }, hourly_cap: 2,
      actions: [{ type: "send_webhook", webhook: hook.json.data.id }],
    } });
    expect(a.status).toBe(201);
    const c = await create(ws.keys.ops, "contact", { first_name: "Cap", email: `${uniq("cap")}@example.com` });
    await call("PATCH", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops, body: { last_name: "Ignored" } });
    for (const t of ["one", "two", "three"]) await call("PATCH", `/v1/objects/contact/records/${c.id}`, { key: ws.keys.ops, body: { job_title: t } });
    await drain(ws);
    const runs = await call("GET", `/v1/automations/${a.json.automation.id}/runs`, { key: ws.keys.admin });
    expect(runs.json.data.map((r: { status: string }) => r.status).sort()).toEqual(["skipped", "succeeded", "succeeded"]);
    expect(forPath("/cap")).toHaveLength(2);
  });
});
