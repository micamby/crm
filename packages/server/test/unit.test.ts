import { HlCrmClient, HlCrmError, newIdempotencyKey } from "@hl-crm-db/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, open, seal } from "../src/lib/crypto.js";
import { decodeId, encodeId, uuidv7 } from "../src/lib/ids.js";
import { normalizeInput } from "../src/core/fieldtypes.js";
import { randomBytes } from "node:crypto";
import { Writable } from "node:stream";
import { createLogger, redactSecrets } from "../src/lib/logger.js";

describe("ids", () => {
  it("round-trips prefixed IDs and sorts by time", async () => {
    const a = uuidv7();
    await new Promise((r) => setTimeout(r, 2));
    const b = uuidv7();
    expect(a < b).toBe(true);
    const pub = encodeId("con", a);
    expect(pub).toMatch(/^con_[0-9A-Z]{26}$/);
    expect(decodeId(pub)).toEqual({ prefix: "con", uuid: a });
  });

  it("rejects malformed IDs", () => {
    for (const bad of ["con_", "con_123", "CON_01JB0000000000000000000000", "x_01JB0000000000000000000000", "con_01JB00000000000000000000O!", "' OR 1=1"]) {
      expect(decodeId(bad)).toBeNull();
    }
  });

  it("decodes view IDs, whose one-letter prefix no object can have", () => {
    const u = uuidv7();
    expect(decodeId(encodeId("v", u))).toEqual({ prefix: "v", uuid: u });
  });
});

describe("SDK idempotency keys", () => {
  afterEach(() => vi.unstubAllGlobals());
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("falls back to getRandomValues where randomUUID is missing (a browser page over plain http)", async () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: <T extends ArrayBufferView>(a: T) => real.getRandomValues(a as never) as T });
    const a = newIdempotencyKey();
    expect(a).toMatch(V4);
    expect(newIdempotencyKey()).not.toBe(a);
    let sent: string | null = null;
    const fetch = (async (_url: URL, init: RequestInit) => {
      sent = new Headers(init.headers).get("idempotency-key");
      return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    await new HlCrmClient({ baseUrl: "http://localhost:8787", apiKey: "k", fetch }).post("/v1/views", {});
    expect(sent).toMatch(V4);
  });

  it("fails clearly when there is no random source at all", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => newIdempotencyKey()).toThrow(HlCrmError);
    expect(() => newIdempotencyKey()).toThrow(/idempotencyKey/);
  });
});

describe("crypto", () => {
  it("seals and opens with matching AAD only", () => {
    const key = randomBytes(32);
    const box = seal(key, Buffer.from("secret"), "t|r|f");
    expect(open(key, box, "t|r|f").toString()).toBe("secret");
    expect(() => open(key, box, "t|r|other")).toThrow();
  });

  it("canonical JSON is key-order independent", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe("field types", () => {
  const f = (type: string, options = {}) => ({ api_name: "x", type: type as never, options, validation: {} });
  it("normalizes valid values", () => {
    expect(normalizeInput(f("email"), " Jane@Example.COM ")).toBe("jane@example.com");
    expect(normalizeInput(f("currency"), "12.345")).toBe(12.35);
    expect(normalizeInput(f("datetime"), "2026-01-02T03:04:05Z")).toBe("2026-01-02T03:04:05.000Z");
    expect(normalizeInput(f("multi_select", { values: [{ key: "a", label: "A" }, { key: "b", label: "B" }] }), ["a", "a", "b"])).toEqual(["a", "b"]);
  });
  it("rejects invalid values", () => {
    expect(() => normalizeInput(f("email"), "nope")).toThrow();
    expect(() => normalizeInput(f("date"), "2026-13-45")).toThrow();
    expect(() => normalizeInput(f("url"), "javascript:alert(1)")).toThrow();
    expect(() => normalizeInput(f("single_select", { values: [{ key: "a", label: "A" }] }), "z")).toThrow();
    expect(() => normalizeInput(f("number"), "abc")).toThrow();
  });
  it("refuses NUL characters in every string type, which Postgres cannot store", () => {
    const values = { values: [{ key: "a", label: "A" }] };
    for (const [type, opts, v] of [["text", {}, "a\0b"], ["long_text", {}, "\0"], ["email", {}, "a\0@b.co"], ["phone", {}, "1\0"], ["url", {}, "https://x.io/\0"],
      ["single_select", values, "a\0"], ["status", values, "\0"], ["multi_select", values, ["a", "\0"]], ["relation", {}, "con_\0"],
      ["relation", { cardinality: "many_to_many" }, ["\0"]], ["date", {}, "2026-01-01\0"], ["datetime", {}, "2026-01-01\0"]] as const) {
      expect(() => normalizeInput(f(type, opts), v), type).toThrow(/NUL/);
    }
  });
});

describe("log redaction", () => {
  it("censors credential-like keys at any depth, and leaves the rest", () => {
    const lines: string[] = [];
    const log = createLogger(new Writable({ write(c, _e, cb) { lines.push(c.toString()); cb(); } }));
    log.level = "info";
    log.info({
      tenantId: "t1", apiKey: "k1", api_key: "k2", "x-api-key": "k3",
      req: { headers: { Authorization: "Bearer hlcrm_abc", cookie: "sid=1" } },
      webhook: { config: { signing: { webhook_secret: "whsec_x", previousSecret: "whsec_y" } } },
      users: [{ name: "a", password: "p1" }, { nested: [{ refresh_token: "r1", accessToken: "a1" }] }],
      status: 500,
    }, "line");
    const out = lines.join("");
    for (const secret of ["k1", "k2", "k3", "hlcrm_abc", "sid=1", "whsec_x", "whsec_y", "p1", "r1", "a1"]) expect(out).not.toContain(secret);
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ tenantId: "t1", status: 500 });
    expect(parsed.users[0]).toEqual({ name: "a", password: "[redacted]" });
    expect(parsed.req.headers.Authorization).toBe("[redacted]");
  });

  it("copes with cycles and deep nesting", () => {
    const a: Record<string, unknown> = { secret: "s" };
    a.self = a;
    expect(redactSecrets(a)).toEqual({ secret: "[redacted]", self: "[circular]" });
    let deep: Record<string, unknown> = { token: "t" };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(redactSecrets(deep))).not.toContain('"t"');
  });
});

describe("credential identity", () => {
  it("is the key, the connected app's grant, or the member; never shared across kinds", async () => {
    const { credential } = await import("../src/core/context.js");
    const base = { tenantId: "t1", actor: { type: "user" as const, id: "u1", role: "member" }, keyId: null, permissions: new Set<never>(), scopes: new Set<never>(),
      surface: "web" as const, requestId: "r" };
    expect(credential({ ...base, keyId: "k1" })).toBe("key:k1");
    expect(credential({ ...base, surface: "ops-mcp", oauth: { grantId: "g1", clientId: "c" } })).toBe("oauth:g1");
    expect(credential(base)).toBe("user:t1:u1");
    expect(credential({ ...base, actor: { type: "system", id: null, role: "owner" } })).toBe("system@t1");
  });
});

describe("SDK errors", () => {
  it("carry Retry-After, so the MCP tools can say how long to wait", async () => {
    const fetch = (async () => new Response(JSON.stringify({ code: "too_many_heavy_requests", detail: "wait" }),
      { status: 429, headers: { "Content-Type": "application/problem+json", "Retry-After": "2" } })) as typeof globalThis.fetch;
    const client = new HlCrmClient({ baseUrl: "http://localhost:1", apiKey: "x", fetch });
    const err = await client.get("/v1/me").catch((e: unknown) => e) as HlCrmError;
    expect(err).toBeInstanceOf(HlCrmError);
    expect(err.retryAfter).toBe(2);
  });
});
