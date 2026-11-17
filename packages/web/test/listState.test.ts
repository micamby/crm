import { describe, expect, it } from "vitest";
import type { SavedView } from "@/lib/api/types";
import { fromWhere, packFilter } from "@/lib/filters";
import { nextSearch, resolveList } from "@/features/list/listState";
import { field, objectMeta } from "./utils";

const meta = objectMeta({ name: "contact", display_field: "first", fields: [
  field({ name: "first", type: "text" }), field({ name: "email", type: "email" }), field({ name: "notes", type: "long_text" }),
  field({ name: "account", type: "relation", relation: { to: "account", cardinality: "many_to_one" } }), field({ name: "secret", type: "text", access: "none" }),
] });
const view: SavedView = { id: "v_1", object: "contact", name: "Mine", shared: false, owner: "usr_1", mine: true, status: "ok", version: 3,
  where: { field: "email", op: "contains", value: "acme" }, sort: [{ field: "email", dir: "desc" }], columns: ["email", "secret", "account"] };

describe("list state from the URL", () => {
  it("uses defaults with no view and nothing in the URL", () => {
    const r = resolveList({}, meta, [], null);
    expect(r.columns).toEqual(["email", "account"]);
    expect(r.sort).toEqual([]);
    expect(r.where).toBeUndefined();
    expect(r.include).toEqual(["account"]);
    expect(r.modified).toBe(false);
  });
  it("takes a view's sort and columns (dropping what the reader can't see) and leaves its where to the server", () => {
    const r = resolveList({ view: "v_1" }, meta, [view], fromWhere(view.where));
    expect(r.columns).toEqual(["email", "account"]);
    expect(r.sort).toEqual([{ field: "email", dir: "desc" }]);
    expect(r.where).toBeUndefined();
    expect(r.filter?.children).toHaveLength(1);
  });
  it("lets the URL override a view, including with no filter at all", () => {
    const r = resolveList({ view: "v_1", sort: "first", cols: "first,email", filter: packFilter({ kind: "group", conj: "and", children: [] }) }, meta, [view], fromWhere(view.where));
    expect(r.sort).toEqual([{ field: "first", dir: "asc" }]);
    expect(r.columns).toEqual(["first", "email"]);
    expect(r.where).toEqual({ field: "id", op: "is_null", value: false });
    expect(r.modified).toBe(true);
  });
  it("ignores sorts on fields that can't be sorted", () => {
    expect(resolveList({ sort: "notes,-first" }, meta, [], null).sort).toEqual([{ field: "first", dir: "desc" }]);
  });
  it("round-trips changes through the URL", () => {
    let s = nextSearch({}, { view: "v_1" });
    expect(s).toEqual({ view: "v_1" });
    s = nextSearch(s, { sort: [{ field: "email", dir: "asc" }], columns: ["email"] });
    s = nextSearch(s, { filter: { kind: "group", conj: "or", children: [{ kind: "cond", path: ["first"], op: "eq", value: "Ada" }] } });
    const r = resolveList(s, meta, [view], fromWhere(view.where));
    expect(r.where).toEqual({ field: "first", op: "eq", value: "Ada" });
    expect(r.columns).toEqual(["email"]);
    expect(nextSearch(s, { view: null })).toEqual({});
    expect(nextSearch(s, { columns: null }).cols).toBeUndefined();
  });
});
