import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Board } from "@/features/board/DealsBoard";
import type { Pipeline } from "@/lib/api/types";
import { field, objectMeta, renderApp, type Call } from "./utils";

const pipelines: Pipeline[] = [{ id: "pipe_1", name: "Sales", is_default: true, stages: [
  { id: "stg_a", name: "Discovery", category: "open", default_probability: 10 },
  { id: "stg_b", name: "Proposal", category: "open", default_probability: 50 },
  { id: "stg_w", name: "Won", category: "won", default_probability: 100 },
] }];
const meta = objectMeta({ name: "deal", label: "Deal", plural_label: "Deals", pipelines, fields: [
  field({ name: "name", type: "text" }), field({ name: "amount", type: "currency" }), field({ name: "currency", type: "text", read_only: true }),
  field({ name: "stage", type: "relation", create_only: true, relation: { to: "stage", cardinality: "many_to_one" } }),
  field({ name: "pipeline", type: "relation", create_only: true, relation: { to: "pipeline", cardinality: "many_to_one" } }),
  field({ name: "owner", type: "relation", relation: { to: "user", cardinality: "many_to_one" } }),
] });
const DEALS = [
  { id: "deal_1", object: "deal", display_name: "Big one", stage: "stg_a", amount: 5000, currency: "USD", version: 1, included: { owner: { id: "usr_1", object: "user", display_name: "Ada" } } },
  { id: "deal_2", object: "deal", display_name: "Euro deal", stage: "stg_a", amount: 300, currency: "EUR", version: 1 },
  { id: "deal_3", object: "deal", display_name: "Done", stage: "stg_w", amount: 100, currency: "USD", version: 1 },
];

function handler(opts: { moveFails?: boolean; totalsFail?: boolean; calls: Call[] }) {
  const deals = structuredClone(DEALS);
  return (c: Call) => {
    opts.calls.push(c);
    if (c.path === "/v1/query") return { body: { data: deals, next_cursor: null } };
    if (c.path === "/v1/aggregate") {
      if (opts.totalsFail) return { status: 429, headers: { "Retry-After": "60" }, body: { code: "too_many_heavy_requests", detail: "Too many heavy requests at once" } };
      const groups = (c.body as { group_by: { field: string }[] }).group_by;
      if (groups.length === 1) return { status: 422, body: { code: "mixed_currencies", detail: "Deals in this group use several currencies" } };
      return { body: { group_by: groups, measures: [{ key: "sum_amount", op: "sum", field: "amount" }], truncated: false, rows_capped: false, data: [
        { group: { stage: { id: "stg_a", display_name: "Discovery" }, currency: "USD" }, count: 1, values: { sum_amount: 5000 }, currency: "USD" },
        { group: { stage: { id: "stg_a", display_name: "Discovery" }, currency: "EUR" }, count: 1, values: { sum_amount: 300 }, currency: "EUR" },
        { group: { stage: { id: "stg_w", display_name: "Won" }, currency: "USD" }, count: 1, values: { sum_amount: 100 }, currency: "USD" },
      ] } };
    }
    if (c.path === "/v1/ops/move_deal_stage") {
      if (opts.moveFails) return { status: 422, body: { code: "validation_failed", detail: "That move isn't allowed", request_id: "req-9" } };
      const b = c.body as { deal: string; stage: string };
      deals.find((d) => d.id === b.deal)!.stage = b.stage;
      return { body: { dry_run: false, result: {} } };
    }
    return undefined;
  };
}

describe("deals board", () => {
  it("shows a column per stage with counts and, when currencies mix, a total per currency", async () => {
    const calls: Call[] = [];
    renderApp(<Board meta={meta} pipelines={pipelines} search={{}} setSearch={() => {}} />, handler({ calls }));
    const discovery = await screen.findByRole("region", { name: /Discovery, 2 deals/ });
    await waitFor(() => expect(discovery.textContent).toMatch(/\$5,000\.00/));
    expect(discovery.textContent).toMatch(/€300\.00/);
    expect(within(discovery).getByRole("link", { name: "Big one" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Proposal, 0 deals/ })).toBeInTheDocument();
    const aggregates = calls.filter((c) => c.path === "/v1/aggregate").map((c) => (c.body as { group_by: { field: string }[] }).group_by.map((g) => g.field));
    expect(aggregates).toEqual([["stage"], ["stage", "currency"]]);
    expect((calls.find((c) => c.path === "/v1/query")!.body as { where: unknown }).where).toEqual({ field: "pipeline", op: "eq", value: "pipe_1" });
  });

  it("moves a card through the stage-move operation, optimistically", async () => {
    const calls: Call[] = [];
    renderApp(<Board meta={meta} pipelines={pipelines} search={{}} setSearch={() => {}} />, handler({ calls }));
    await userEvent.click(await screen.findByRole("button", { name: "Move Big one" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Proposal" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: /^Proposal/ })).getByRole("link", { name: "Big one" })).toBeInTheDocument());
    const move = calls.find((c) => c.path === "/v1/ops/move_deal_stage")!;
    expect(move.body).toEqual({ deal: "deal_1", stage: "stg_b" });
    expect(move.headers["idempotency-key"]).toBeTruthy();
  });

  it("puts the card back and says why when the move is refused", async () => {
    const calls: Call[] = [];
    renderApp(<Board meta={meta} pipelines={pipelines} search={{}} setSearch={() => {}} />, handler({ calls, moveFails: true }));
    await userEvent.click(await screen.findByRole("button", { name: "Move Big one" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Proposal" }));
    expect(await screen.findByText("That move isn't allowed")).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole("region", { name: /^Discovery/ })).getByRole("link", { name: "Big one" })).toBeInTheDocument());
  });

  it("shows the cards and counts without totals when totals can't be loaded, quietly", async () => {
    const calls: Call[] = [];
    renderApp(<Board meta={meta} pipelines={pipelines} search={{}} setSearch={() => {}} />, handler({ calls, totalsFail: true }));
    const discovery = await screen.findByRole("region", { name: /Discovery, 2 deals/ });
    expect(within(discovery).getByRole("link", { name: "Big one" })).toBeInTheDocument();
    expect(await screen.findByText(/server is busy, so column totals are left out/)).toBeInTheDocument();
    expect(discovery.querySelector("header")!.textContent).toBe("Discovery2");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("keyboard dragging on the board", () => {
  it("moves one column per arrow press", async () => {
    const { columnCoordinates } = await import("@/features/board/DealsBoard");
    const col = (left: number) => ({ left, width: 288, top: 0, height: 600, right: left + 288, bottom: 600 });
    const rects = new Map([["a", col(0)], ["b", col(300)], ["c", col(600)]]);
    const context = { collisionRect: { left: 20, top: 50, width: 250, height: 90, right: 270, bottom: 140 }, droppableRects: rects, droppableContainers: new Map([["a", {}], ["b", {}], ["c", {}]]) };
    const key = (code: string) => ({ code, preventDefault() {} }) as KeyboardEvent;
    const right = columnCoordinates(key("ArrowRight"), { active: "deal_1", currentCoordinates: { x: 20, y: 50 }, context: context as never });
    // Over the next column, centred: never a 25 px nudge that leaves it in the same stage.
    expect(right).toEqual({ x: 319, y: 50 });
    expect(columnCoordinates(key("ArrowLeft"), { active: "deal_1", currentCoordinates: { x: 20, y: 50 }, context: context as never })).toEqual({ x: 20, y: 50 });
    expect(columnCoordinates(key("ArrowDown"), { active: "deal_1", currentCoordinates: { x: 20, y: 50 }, context: context as never })).toEqual({ x: 20, y: 50 });
  });
});
