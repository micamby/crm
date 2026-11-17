import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "../src/db/tx.js";
import { deliverDue, EVENT_MAX_ATTEMPTS, processEvents } from "../src/worker/events.js";
import { call, create, newWorkspace } from "./helpers.js";

process.env.WEBHOOK_ALLOW_INSECURE_TARGETS = "true";

/** Fails event processing for account events while `failures` is above zero: a transient fault inside the savepoint. */
const fault = vi.hoisted(() => ({ failures: 0 }));
vi.mock("../src/core/automations.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/core/automations.js")>();
  return {
    ...real,
    runAutomationsForEvent: async (...args: Parameters<typeof real.runAutomationsForEvent>) => {
      if (args[2].type === "account.created" && fault.failures > 0) {
        fault.failures--;
        throw Object.assign(new Error("could not serialize access due to concurrent update"), { code: "40001" });
      }
      return real.runAutomationsForEvent(...args);
    },
  };
});

let server: Server;
let base = "";
const received: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body).type);
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const makeDue = (t: string) => withTenant(t, (tx) => tx`UPDATE outbox_events SET next_attempt_at = now() WHERE next_attempt_at IS NOT NULL`);

describe("event retries", () => {
  it("a transient failure is retried with backoff instead of being dropped, and other events carry on", async () => {
    const ws = await newWorkspace("Event retry");
    await call("POST", "/v1/webhooks", { key: ws.keys.admin, body: { url: `${base}/events`, events: ["account.created", "contact.created"] } });
    fault.failures = 1;
    await create(ws.keys.ops, "account", { name: "Retried Co" });
    await create(ws.keys.ops, "contact", { first_name: "Behind", email: `behind-${Date.now()}@example.com` });
    await processEvents(ws.tenantId);
    await deliverDue(ws.tenantId);
    expect(received).toEqual(["contact.created"]); // the account event failed; the one behind it went out
    const pending = await call("GET", "/v1/events?status=pending&type=account.", { key: ws.keys.ops });
    expect(pending.json.data).toHaveLength(1);
    expect(pending.json.data[0].processing).toMatchObject({ status: "pending", attempts: 1, last_error: "internal error (40001)" });
    expect(new Date(pending.json.data[0].processing.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 5_000);
    // Not due yet: nothing happens.
    expect(await processEvents(ws.tenantId)).toBe(0);
    await makeDue(ws.tenantId);
    await processEvents(ws.tenantId);
    await deliverDue(ws.tenantId);
    expect(received).toEqual(["contact.created", "account.created"]);
    const done = await call("GET", "/v1/events?type=account.", { key: ws.keys.ops });
    expect(done.json.data[0].processing).toMatchObject({ status: "processed", attempts: 1 });
  });

  it("dead-letters after the last attempt, visibly, without blocking later events", async () => {
    const ws = await newWorkspace("Event dead");
    fault.failures = Infinity;
    await create(ws.keys.ops, "account", { name: "Poison" });
    for (let i = 0; i < EVENT_MAX_ATTEMPTS; i++) {
      await makeDue(ws.tenantId);
      await processEvents(ws.tenantId);
    }
    fault.failures = 0;
    await makeDue(ws.tenantId);
    expect(await processEvents(ws.tenantId)).toBe(0); // dead events are not picked up again
    const dead = await call("GET", "/v1/events?status=dead", { key: ws.keys.ops });
    expect(dead.json.data).toHaveLength(1);
    expect(dead.json.data[0]).toMatchObject({ type: "account.created", processing: { status: "dead", attempts: EVENT_MAX_ATTEMPTS, next_attempt_at: null } });
    await create(ws.keys.ops, "account", { name: "After" });
    expect(await processEvents(ws.tenantId)).toBe(1);
    expect((await call("GET", "/v1/events?status=processed&type=account.", { key: ws.keys.ops })).json.data).toHaveLength(1);
  });
});
