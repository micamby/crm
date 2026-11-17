import { describe, expect, it } from "vitest";
import { ApiProblem, asProblem, fieldErrorsOf, problemFromResponse, problemTitle } from "@/lib/api/problem";

describe("problem responses", () => {
  it("pulls field messages out of every shape the API uses", () => {
    expect(fieldErrorsOf({ errors: [{ field: "email", message: "must be a valid email address" }, { field: "email", message: "second" }] })).toEqual({ email: "must be a valid email address" });
    expect(fieldErrorsOf([{ path: "values.amount", message: "Expected number" }])).toEqual({ values: "Expected number" });
    expect(fieldErrorsOf({ field: "domain" })).toEqual({ domain: "already exists on another record" });
    expect(fieldErrorsOf({ allowed: ["a"] })).toEqual({});
    expect(fieldErrorsOf(undefined)).toEqual({});
  });
  it("reads a problem document with its request ID and Retry-After", async () => {
    const res = new Response(JSON.stringify({ type: "x", title: "rate_limited", status: 429, detail: "Slow down", code: "rate_limited", request_id: "req-1" }),
      { status: 429, headers: { "Retry-After": "3", "Content-Type": "application/problem+json" } });
    const p = await problemFromResponse(res);
    expect(p).toMatchObject({ status: 429, code: "rate_limited", detail: "Slow down", requestId: "req-1", retryAfter: 3 });
    expect(p.title).toBe("Too many requests");
  });
  it("copes with a body that isn't a problem document", async () => {
    const p = await problemFromResponse(new Response("<html>bad gateway</html>", { status: 502, statusText: "Bad Gateway", headers: { "X-Request-Id": "r2" } }));
    expect(p).toMatchObject({ status: 502, code: "http_502", requestId: "r2" });
    expect(p.title).toBe("Something went wrong on the server");
  });
  it("gives every status a readable title", () => {
    expect(problemTitle(412, "version_mismatch")).toBe("Changed by someone else");
    expect(problemTitle(403, "something_new")).toBe("You don't have access to this");
    expect(asProblem(new TypeError("Failed to fetch")).title).toBe("Can't reach the server");
  });
  it("rewords refusals written for an API key holder for the person using the app, keeping the server's words", () => {
    const p = new ApiProblem({ status: 403, code: "forbidden", detail: 'This key lacks the "audit:read" permission' });
    expect(p.detail).toBe("Your role doesn't allow this: it needs permission to read the audit log. Ask a workspace admin if you need it.");
    expect(p.detail).not.toMatch(/key/i);
    expect(p.serverDetail).toBe('This key lacks the "audit:read" permission');
    expect(new ApiProblem({ status: 403, code: "forbidden", detail: 'This key lacks the "records:read" permission on every object' }).detail).toContain("read records");
    expect(new ApiProblem({ status: 403, code: "forbidden", detail: "Listing all keys needs the keys:manage permission" }).detail).toBe("Listing all keys needs permission to manage API keys");
    expect(new ApiProblem({ status: 403, code: "forbidden", detail: "This key can't read lead.contact, so it can't convert leads" }).detail).toMatch(/^Your role can't read/);
    expect(new ApiProblem({ status: 403, code: "recent_sign_in_required", detail: "Sign in again to do this" }).title).toBe("Confirm it's you first");
    // Other statuses are left alone.
    expect(new ApiProblem({ status: 422, code: "validation_failed", detail: "This key is odd" }).detail).toBe("This key is odd");
  });
  it("names no internal operation when a lead's status can only change by converting it", () => {
    const p = new ApiProblem({ status: 403, code: "forbidden", detail: 'lead.status cannot be set to "converted" directly; use the named operation (for leads: convert_lead)' });
    expect(p.detail).toBe('lead.status cannot be set to "converted" directly: convert the lead from its page instead');
  });
});
