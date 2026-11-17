import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/app.js";
import { route } from "../src/api/registry.js";
import { call, newWorkspace, type Workspace } from "./helpers.js";

let ws: Workspace;
beforeAll(async () => {
  ws = await newWorkspace("Guards");
});

describe("NUL characters", () => {
  it("are refused with a 422 in a body, a query string or a path, before anything reaches Postgres", async () => {
    for (const [method, path, body] of [
      ["POST", "/v1/objects/contact/records", { first_name: "A\u0000" }],
      ["POST", "/v1/objects/contact/records", { "first\u0000name": "A" }],
      ["PATCH", "/v1/objects/contact/fields/email", { label: "E\u0000mail" }],
      ["POST", "/v1/roles", { key: "nul_role", name: "Nul\u0000", permissions: ["records:read"] }],
      ["GET", "/v1/search?q=a%00b", undefined],
      ["GET", "/v1/objects/contact/records?filter[first_name]=%00", undefined],
      ["GET", "/v1/objects/con%00tact", undefined],
    ] as const) {
      const r = await call(method, path, { key: ws.keys.admin, body });
      expect(r.status, `${method} ${path}`).toBe(422);
      expect(r.json.detail).toMatch(/NUL/);
    }
  });
});

describe("idempotent replay", () => {
  it("returns a text response with its Content-Type and headers, sealed and with key-shaped text redacted", async () => {
    let calls = 0;
    route({
      method: "POST", path: "/v1/test-only/text", scope: "ops:write", tag: "records", summary: "test only",
      handler: async () => {
        calls++;
        // Built in two parts so the secret scanner does not read this made-up key as a real one.
        return { body: `id,note\r\n1,${"hlcrm_" + "live_"}abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrst\r\n`,
          headers: { "Content-Type": "text/csv; charset=utf-8", "X-Row-Count": "1" } };
      },
    });
    const app = buildApp();
    const key = `text-${Date.now()}`;
    const again = () => app.request("/v1/test-only/text", { method: "POST", body: "{}",
      headers: { Authorization: `Bearer ${ws.keys.ops}`, "Content-Type": "application/json", "Idempotency-Key": key } });
    const first = await again();
    expect(first.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(await first.text()).toContain("hlcrm_live_");
    const replay = await again();
    expect(calls).toBe(1);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(replay.headers.get("x-row-count")).toBe("1");
    expect(await replay.text()).toBe("id,note\r\n1,[redacted]\r\n");
  });
});
