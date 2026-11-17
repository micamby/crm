import { QueryCache, QueryClient, useQuery } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BusyStatus } from "@/components/BusyStatus";
import { useApi } from "@/lib/api/context";
import { renderApp } from "./utils";

function Count() {
  const api = useApi();
  const q = useQuery({ queryKey: ["count"], queryFn: () => api.post<{ total: number }>("/v1/query", { object: "deal", count: true }), retry: false });
  return <p>{q.data ? `${q.data.total} deals` : "loading"}</p>;
}

describe("a background refresh turned away as busy", () => {
  it("keeps what's on screen and says 'busy, retrying' quietly instead of an error", async () => {
    let n = 0;
    const client = new QueryClient({ queryCache: new QueryCache(), defaultOptions: { queries: { retry: false } } });
    renderApp(<><Count /><BusyStatus /></>, (c) => (c.path === "/v1/query"
      ? (++n === 1 ? { body: { total: 12 } } : { status: 429, body: { code: "too_many_heavy_requests", detail: "busy" }, headers: { "Retry-After": "1" } })
      : undefined), { client });
    expect(await screen.findByText("12 deals")).toBeInTheDocument();
    expect(screen.queryByText(/busy, retrying/i)).not.toBeInTheDocument();
    await client.refetchQueries({ queryKey: ["count"] }).catch(() => {});
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Busy, retrying…"));
    expect(screen.getByText("12 deals")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The request helper retried the heavy request several times before giving up.
    expect(n).toBeGreaterThan(2);
  });
});
