import { describe, expect, it, vi } from "vitest";
import { ApiClient, apiUrl, isHeavy } from "@/lib/api/client";
import { ApiProblem } from "@/lib/api/problem";
import { fakeFetch } from "./utils";

describe("the request helper", () => {
  it("sends the CSRF token and an idempotency key on writes, never on reads, and If-Match when asked", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { ok: true } }));
    const api = new ApiClient({ fetch });
    api.setCsrfToken("tok");
    await api.get("/v1/me");
    await api.patch("/v1/objects/contact/records/con_1", { a: 1 }, { ifMatch: 4 });
    expect(calls[0]!.headers["x-csrf-token"]).toBeUndefined();
    expect(calls[0]!.headers["idempotency-key"]).toBeUndefined();
    expect(calls[1]!.headers).toMatchObject({ "x-csrf-token": "tok", "if-match": '"v4"', "content-type": "application/json" });
    expect(calls[1]!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls.every((c) => !("authorization" in c.headers))).toBe(true);
  });

  it("fetches the token first when it has none, and once more after a csrf_failed refusal, with the same idempotency key", async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch((c) => {
      if (c.path === "/v1/auth/session") return { body: { csrf_token: `t${++n}` } };
      if (c.headers["x-csrf-token"] === "t1") return { status: 403, body: { code: "csrf_failed", detail: "stale" } };
      return { status: 201, body: { data: { id: "x" } } };
    });
    const api = new ApiClient({ fetch });
    await api.post("/v1/views", { name: "x" });
    const writes = calls.filter((c) => c.method === "POST");
    expect(writes.map((c) => c.headers["x-csrf-token"])).toEqual(["t1", "t2"]);
    expect(writes[0]!.headers["idempotency-key"]).toBe(writes[1]!.headers["idempotency-key"]);
  });

  it("calls the sign-in endpoints without CSRF and without treating 401 as a lost session", async () => {
    const lost = vi.fn();
    const { fetch, calls } = fakeFetch(() => ({ status: 401, body: { code: "sign_in_failed", detail: "no" } }));
    const api = new ApiClient({ fetch, onUnauthenticated: lost });
    await expect(api.post("/auth/password", { email: "a", password: "b" })).rejects.toBeInstanceOf(ApiProblem);
    expect(lost).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers["x-csrf-token"]).toBeUndefined();
  });

  it("reports a 401 to the app and forgets the token", async () => {
    const lost = vi.fn();
    const { fetch } = fakeFetch(() => ({ status: 401, body: { code: "unauthenticated", detail: "ended" } }));
    const api = new ApiClient({ fetch, onUnauthenticated: lost });
    api.setCsrfToken("tok");
    await expect(api.get("/v1/me")).rejects.toMatchObject({ status: 401 });
    expect(lost).toHaveBeenCalledOnce();
    expect(api.hasCsrfToken()).toBe(false);
  });

  it("waits out Retry-After on 429 and retries, a few times for the heavy-request limit", async () => {
    let n = 0;
    const sleep = vi.fn(async () => {});
    const { fetch } = fakeFetch(() => (++n < 4 ? { status: 429, body: { code: "too_many_heavy_requests", detail: "busy" }, headers: { "Retry-After": "1" } } : { body: { data: [] } }));
    const api = new ApiClient({ fetch, sleep });
    await api.post("/v1/aggregate", { object: "deal" });
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(1000);
    const once = fakeFetch(() => ({ status: 429, body: { code: "rate_limited", detail: "slow" }, headers: { "Retry-After": "2" } }));
    await expect(new ApiClient({ fetch: once.fetch, sleep }).get("/v1/me")).rejects.toMatchObject({ status: 429, retryAfter: 2 });
    expect(once.calls).toHaveLength(2);
  });

  it("runs at most two heavy requests at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetch = (async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof globalThis.fetch;
    const api = new ApiClient({ fetch });
    api.setCsrfToken("t");
    await Promise.all([1, 2, 3, 4, 5].map(() => api.post("/v1/query", { object: "deal", count: true })));
    expect(peak).toBe(2);
    expect(isHeavy("POST", "/v1/query", { body: { count: false } })).toBe(false);
    expect(isHeavy("GET", "/v1/objects/deal/records", { query: { count: true } })).toBe(true);
    expect(isHeavy("POST", "/v1/objects/deal/records/bulk_archive", {})).toBe(true);
  });

  it("on recent_sign_in_required, has the person confirm it's them once and retries with the new session's token", async () => {
    let confirmed = false;
    const { fetch, calls } = fakeFetch((c) => (c.path === "/v1/api-keys" && !confirmed
      ? { status: 403, body: { code: "recent_sign_in_required", detail: "Sign in again to do this" } }
      : { status: 201, body: { data: { secret: "s" } } }));
    const hook = vi.fn(async () => {
      confirmed = true;
      withHook.setCsrfToken("fresh");
      return true;
    });
    const withHook: ApiClient = new ApiClient({ fetch, onRecentSignInRequired: hook });
    withHook.setCsrfToken("old");
    // Two writes at once share one confirmation.
    const [a, b] = await Promise.all([withHook.post("/v1/api-keys", { name: "a" }), withHook.post("/v1/api-keys", { name: "b" })]);
    expect(a).toEqual({ data: { secret: "s" } });
    expect(b).toEqual({ data: { secret: "s" } });
    expect(hook).toHaveBeenCalledOnce();
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(4);
    expect(posts.map((c) => c.headers["x-csrf-token"])).toEqual(["old", "old", "fresh", "fresh"]);
    // The retry is the same request (same idempotency key).
    expect(new Set(posts.map((c) => c.headers["idempotency-key"])).size).toBe(2);
  });

  it("throws recent_sign_in_required (with a person's wording) when the person doesn't confirm, and asks only once per request", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 403, body: { code: "recent_sign_in_required", detail: "Sign in again to do this" } }));
    const hook = vi.fn(async () => true);
    const api = new ApiClient({ fetch, onRecentSignInRequired: hook });
    api.setCsrfToken("t");
    await expect(api.post("/v1/api-keys", {})).rejects.toMatchObject({ code: "recent_sign_in_required", title: "Confirm it's you first" });
    expect(hook).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(2);
    const declined = new ApiClient({ fetch, onRecentSignInRequired: async () => false });
    declined.setCsrfToken("t");
    await expect(declined.post("/v1/api-keys", {})).rejects.toMatchObject({ code: "recent_sign_in_required" });
  });

  it("refuses to call anything but the API's own paths", () => {
    for (const p of ["https://evil.example/v1/me", "//evil.example/v1", "/v1/../auth", "/assets/x", "/v1/me?x=1"]) expect(() => apiUrl(p), p).toThrow();
    expect(apiUrl("/v1/users", { q: "a b", limit: 5, empty: "", none: undefined })).toBe("/v1/users?q=a+b&limit=5");
    // Nothing outside /v1 and /auth: whether OAuth for MCP is on comes from the session info, not a discovery document.
    for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) expect(() => apiUrl(p), p).toThrow();
  });
});
