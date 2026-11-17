import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { Page, RecordData } from "@/lib/api/types";
import { qk } from "@/lib/keys";
import { applyWrite, touchedBy } from "@/lib/writes";

const rec = (id: string, extra: Record<string, unknown> = {}): RecordData => ({ id, object: "contact", display_name: id, version: 1, created_at: "", updated_at: "", ...extra }) as RecordData;
const page = (rows: RecordData[]): InfiniteData<Page, unknown> => ({ pages: [{ data: rows, next_cursor: null, total: rows.length } as unknown as Page], pageParams: [undefined] });

function seeded() {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  qc.setQueryData(qk.record("contact", "c1"), rec("c1", { job_title: "CTO", account: "a1", included: { account: { id: "a1", display_name: "Acme" } } }));
  qc.setQueryData(qk.list("contact", { view: null }), page([rec("c1", { job_title: "CTO", account: "a1", included: { account: { id: "a1", display_name: "Acme" } } }), rec("c2")]));
  qc.setQueryData(qk.related("contact", { field: "account", id: "a1" }), { data: [rec("c1", { job_title: "CTO" })], next_cursor: null, total: 1 });
  qc.setQueryData(qk.aggregate("contact", { by: "job_title" }), { data: [] });
  qc.setQueryData(qk.record("contact", "c2"), rec("c2"));
  qc.setQueryData(qk.timeline("c1"), []);
  qc.setQueryData(qk.timeline("other"), []);
  qc.setQueryData(qk.search("ada"), []);
  qc.setQueryData(qk.attention, { counts: { unread: 1 } });
  qc.setQueryData(qk.records("deal").concat("list") as unknown as string[], page([]));
  return qc;
}
const stale = (qc: QueryClient, key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated;

describe("applyWrite: every write's effect on the cache", () => {
  it("puts the server's record (value and version) on the record's page and in every loaded row, and refreshes what depends on it", () => {
    const qc = seeded();
    applyWrite(qc, { object: "contact", id: "c1", record: rec("c1", { job_title: "CEO", account: "a1", version: 2 }) });
    const r = qc.getQueryData<RecordData>(qk.record("contact", "c1"))!;
    expect(r).toMatchObject({ job_title: "CEO", version: 2 });
    // A PATCH answer has no include: the related names stay.
    expect(r.included?.account?.display_name).toBe("Acme");
    const row = qc.getQueryData<InfiniteData<Page>>(qk.list("contact", { view: null }))!.pages[0]!.data[0]!;
    expect(row).toMatchObject({ job_title: "CEO", version: 2 });
    expect((qc.getQueryData<Page>(qk.related("contact", { field: "account", id: "a1" }))!.data[0]!).job_title).toBe("CEO");
    // The record just written is fresh; lists (counts), aggregates, related lists, its timeline and search are stale.
    expect(stale(qc, qk.record("contact", "c1"))).toBe(false);
    expect(stale(qc, qk.list("contact", { view: null }))).toBe(true);
    expect(stale(qc, qk.aggregate("contact", { by: "job_title" }))).toBe(true);
    expect(stale(qc, qk.related("contact", { field: "account", id: "a1" }))).toBe(true);
    expect(stale(qc, qk.timeline("c1"))).toBe(true);
    expect(stale(qc, qk.search("ada"))).toBe(true);
    // Unrelated things are left alone.
    expect(stale(qc, qk.timeline("other"))).toBe(false);
    expect(stale(qc, ["records", "deal", "list"])).toBe(false);
    expect(stale(qc, qk.attention)).toBe(false);
  });

  it("refetches the record when a relation changed (its related names are stale)", () => {
    const qc = seeded();
    applyWrite(qc, { object: "contact", id: "c1", record: rec("c1", { account: "a2", version: 2 }) });
    expect(stale(qc, qk.record("contact", "c1"))).toBe(true);
    const row = qc.getQueryData<InfiniteData<Page>>(qk.list("contact", { view: null }))!.pages[0]!.data[0]!;
    expect(row.account).toBe("a2");
    expect(row.included?.account).toBeUndefined();
  });

  it("drops an archived record from loaded lists", () => {
    const qc = seeded();
    applyWrite(qc, { object: "contact", id: "c1", removed: true });
    expect(qc.getQueryData<InfiniteData<Page>>(qk.list("contact", { view: null }))!.pages[0]!.data.map((r) => r.id)).toEqual(["c2"]);
    expect(stale(qc, qk.record("contact", "c1"))).toBe(true);
  });

  it("a task's change refreshes the inbox, my tasks and the timelines of the records it is on", () => {
    const qc = seeded();
    qc.setQueryData(qk.myTasks, []);
    applyWrite(qc, { object: "task", id: "t1", record: rec("t1", { status: "done" }), touched: touchedBy({ related: [{ id: "d1", object: "deal" }] }) });
    expect(stale(qc, qk.attention)).toBe(true);
    expect(stale(qc, qk.myTasks)).toBe(true);
    expect(stale(qc, qk.timeline("other"))).toBe(true);
    expect(touchedBy({ related: [{ id: "d1", object: "deal" }], related_to: ["d1", "c9"] })).toEqual([{ object: "deal", id: "d1" }, { id: "c9" }]);
  });
});
