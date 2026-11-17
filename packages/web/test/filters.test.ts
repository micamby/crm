import { describe, expect, it } from "vitest";
import { andWhere, compileWhere, countConditions, encodeFilter, formatSort, fromWhere, packFilter, parseColumns, parseSort, unpackFilter, type Group } from "@/lib/filters";

const g: Group = {
  kind: "group", conj: "and", children: [
    { kind: "cond", path: ["name"], op: "contains", value: "acme" },
    { kind: "cond", path: ["account", "industry"], op: "eq", value: "Software" },
    { kind: "cond", path: ["owner"], op: "empty" },
    { kind: "group", conj: "or", children: [
      { kind: "cond", path: ["amount"], op: "gte", value: 1000 },
      { kind: "cond", path: ["stage"], op: "in", value: ["stg_a", "stg_b"] },
      { kind: "cond", path: ["closed"], op: "eq", value: "" },
    ] },
  ],
};

describe("where compiler", () => {
  it("compiles groups, relation paths and empty checks, leaving out incomplete conditions", () => {
    expect(compileWhere(g)).toEqual({ and: [
      { field: "name", op: "contains", value: "acme" },
      { path: ["account", "industry"], op: "eq", value: "Software" },
      { field: "owner", op: "is_null", value: true },
      { or: [{ field: "amount", op: "gte", value: 1000 }, { field: "stage", op: "in", value: ["stg_a", "stg_b"] }] },
    ] });
    expect(countConditions(g)).toBe(5);
  });
  it("collapses single children and drops empty groups", () => {
    expect(compileWhere({ kind: "group", conj: "or", children: [{ kind: "cond", path: ["x"], op: "not_empty" }] })).toEqual({ field: "x", op: "is_null", value: false });
    expect(compileWhere({ kind: "group", conj: "and", children: [] })).toBeUndefined();
    expect(andWhere(undefined, { field: "a", op: "eq", value: 1 })).toEqual({ field: "a", op: "eq", value: 1 });
    expect(andWhere({ field: "a", op: "eq", value: 1 }, { field: "b", op: "eq", value: 2 })).toEqual({ and: [{ field: "a", op: "eq", value: 1 }, { field: "b", op: "eq", value: 2 }] });
  });
  it("reads a saved view's where back into the builder, and gives up on `not`", () => {
    const back = fromWhere(compileWhere(g));
    expect(compileWhere(back)).toEqual(compileWhere(g));
    expect(fromWhere({ not: { field: "a", op: "eq", value: 1 } })).toBeNull();
    expect(fromWhere({ field: "a", op: "eq", value: 1 })).toEqual({ kind: "group", conj: "and", children: [{ kind: "cond", path: ["a"], op: "eq", value: 1 }] });
  });
});

describe("URL form", () => {
  it("round-trips through the packed JSON form", () => {
    expect(unpackFilter(encodeFilter(g))).toEqual(g);
    expect(unpackFilter(packFilter(g))).toEqual(g);
  });
  it("refuses anything odd from a URL", () => {
    for (const bad of ["{", "[]", '{"o":"xor","c":[]}', '{"o":"and","c":[["a","drop_table"]]}', '{"o":"and","c":[["A-B","eq","x"]]}',
      '{"o":"and","c":[["a.b.c.d","eq","x"]]}', '{"o":"and","c":[["a","eq",{"x":1}]]}', JSON.stringify({ o: "and", c: Array.from({ length: 41 }, () => ["a", "empty"]) })]) {
      expect(unpackFilter(bad), bad).toBeNull();
    }
    let deep: unknown = { o: "and", c: [] };
    for (let i = 0; i < 6; i++) deep = { o: "and", c: [deep] };
    expect(unpackFilter(deep)).toBeNull();
  });
  it("parses and formats sorts and columns", () => {
    expect(parseSort("name,-amount,created_at,extra")).toEqual([{ field: "name", dir: "asc" }, { field: "amount", dir: "desc" }, { field: "created_at", dir: "asc" }]);
    expect(formatSort(parseSort("-amount,name"))).toBe("-amount,name");
    expect(parseSort("Bad,name,name")).toEqual([{ field: "name", dir: "asc" }]);
    expect(parseColumns("a,b,,B,a")).toEqual(["a", "b"]);
    expect(parseColumns("")).toEqual([]);
    expect(parseColumns(undefined)).toBeUndefined();
  });
});
