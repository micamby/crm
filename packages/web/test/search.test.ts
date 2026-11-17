import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { ApiClient } from "@/lib/api/client";
import { reauthHref } from "@/lib/session";
import { createAppRouter, parseSearch, stringifySearch } from "@/router";

/** Search params: plain values stay plain text in the URL (no JSON quotes), structured ones are compact JSON, and old bookmarks still work. */
describe("search params in URLs", () => {
  it("writes plain values as plain text: reauth=1, not reauth=%221%22", () => {
    expect(stringifySearch({ reauth: "1", return_to: "/settings/api-keys" })).toBe("?reauth=1&return_to=%2Fsettings%2Fapi-keys");
    expect(stringifySearch({ view: "v_9", sort: "-amount,name", cols: "name,amount", pipeline: "pip_1", state: "open" }))
      .toBe("?view=v_9&sort=-amount%2Cname&cols=name%2Camount&pipeline=pip_1&state=open");
    // Numbers and words JSON would read as something else stay text both ways.
    for (const v of ["1", "true", "null", "-5", "2026-01-01"]) expect(parseSearch(stringifySearch({ x: v }))).toEqual({ x: v });
  });

  it("keeps a filter as compact JSON, and quotes only a plain string that would otherwise read back as JSON", () => {
    const filter = { o: "and", c: [["amount", "gte", 5000], ["name", "contains", "a b"]] };
    const written = stringifySearch({ filter });
    expect(written).toBe(`?${new URLSearchParams({ filter: JSON.stringify(filter) })}`);
    expect(parseSearch(written)).toEqual({ filter });
    for (const v of ['{"not":"an object"}', "[x", '"quoted"']) expect(parseSearch(stringifySearch({ q: v }))).toEqual({ q: v });
  });

  it("reads bookmarks in the old form: JSON-quoted strings, JSON filters", () => {
    expect(parseSearch("?reauth=%221%22&return_to=%22%2Fsettings%2Fapi-keys%22")).toEqual({ reauth: "1", return_to: "/settings/api-keys" });
    expect(parseSearch("?sort=-amount&filter=%7B%22o%22%3A%22and%22%2C%22c%22%3A%5B%5D%7D")).toEqual({ sort: "-amount", filter: { o: "and", c: [] } });
  });

  it("the app's own re-authentication link stays clean once the router has read it, and the old form still means reauth", async () => {
    for (const [url, clean] of [[reauthHref("/settings/api-keys"), true], ["/sign-in?reauth=%221%22&return_to=%2Fsettings%2Fapi-keys", false]] as const) {
      const router = createAppRouter({ api: new ApiClient({ fetch: (async () => new Response("{}")) as typeof fetch }), queryClient: new QueryClient() },
        createMemoryHistory({ initialEntries: [url] }));
      await router.load();
      const match = router.state.matches.find((m) => m.routeId === "/sign-in")!;
      expect(match.search).toMatchObject({ reauth: "1", return_to: "/settings/api-keys" });
      const href = router.buildLocation({ to: "/sign-in", search: match.search as never }).href;
      expect(href).not.toContain("%22");
      expect(new URL(href, "http://x").searchParams.get("reauth")).toBe("1");
      if (clean) expect(url).toBe("/sign-in?reauth=1&return_to=%2Fsettings%2Fapi-keys");
    }
  });
});
