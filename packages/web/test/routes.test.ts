import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import manifest from "@/app-routes.json";
import { ApiClient } from "@/lib/api/client";
import { createAppRouter } from "@/router";

describe("app routes", () => {
  it("lists every top-level route of the router in app-routes.json, which tells the server where to serve the app", () => {
    const router = createAppRouter({ api: new ApiClient(), queryClient: new QueryClient() });
    const tops = new Set(Object.keys(router.routesByPath).map((p) => `/${p.split("/")[1] ?? ""}`));
    expect(tops.size).toBeGreaterThan(4);
    for (const t of tops) expect(manifest.routes, `${t} is a route of the app but not in src/app-routes.json`).toContain(t);
    // And nothing the API owns is claimed by the app.
    for (const r of manifest.routes) expect(r).not.toMatch(/^\/(v1|auth|oauth|mcp|\.well-known|healthz|readyz|openapi\.json|assets)$/);
  });
});
