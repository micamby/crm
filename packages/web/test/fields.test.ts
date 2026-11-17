import { describe, expect, it } from "vitest";
import type { FieldType } from "@/lib/api/types";
import {
  allowedStatuses, canSort, canWrite, defaultColumns, includable, keyFacts, operatorsFor, readOnlyReason, toApiValue, toFormValue, validateValues,
} from "@/meta/fields";
import { field, objectMeta } from "./utils";

const ALL: FieldType[] = ["text", "long_text", "number", "currency", "boolean", "date", "datetime", "single_select", "multi_select", "email", "phone", "url", "relation", "status"];

describe("operators per field type", () => {
  it("offers only what the API's query compiler accepts for each of the 14 types", () => {
    const ops = Object.fromEntries(ALL.map((t) => [t, operatorsFor(t).map((o) => o.op)]));
    for (const t of ["text", "long_text", "email", "phone", "url"]) expect(ops[t]).toEqual(["contains", "eq", "neq", "starts_with", "empty", "not_empty"]);
    for (const t of ["single_select", "status", "relation"]) expect(ops[t]).toEqual(["eq", "neq", "in", "not_in", "empty", "not_empty"]);
    for (const t of ["number", "currency"]) expect(ops[t]).toEqual(["eq", "neq", "gt", "gte", "lt", "lte", "empty", "not_empty"]);
    expect(ops.date).toEqual(["eq", "lt", "gt", "gte", "lte", "empty", "not_empty"]);
    expect(ops.datetime).toEqual(["lt", "gt", "empty", "not_empty"]);
    expect(ops.multi_select).toEqual(["contains", "empty", "not_empty"]);
    expect(ops.boolean).toEqual(["eq", "empty", "not_empty"]);
    // Every type has at least one operator and every label is distinct within a type.
    for (const t of ALL) expect(new Set(operatorsFor(t).map((o) => o.label)).size).toBe(operatorsFor(t).length);
  });
});

describe("sorting and writing", () => {
  it("sorts every readable, unrestricted type except relations, multi-selects and long text", () => {
    for (const t of ALL) expect(canSort(field({ name: "f", type: t })), t).toBe(!["relation", "multi_select", "long_text"].includes(t));
    expect(canSort(field({ name: "f", type: "text", sensitivity: "restricted" }))).toBe(false);
    expect(canSort(field({ name: "f", type: "text", access: "none" }))).toBe(false);
  });

  it("writes only with write on the object and the field, never system fields, create-only fields only on create", () => {
    const rw = { read: true, write: true, archive: true };
    expect(canWrite(field({ name: "a", type: "text" }), rw, "edit")).toBe(true);
    expect(canWrite(field({ name: "a", type: "text" }), { ...rw, write: false }, "edit")).toBe(false);
    expect(canWrite(field({ name: "a", type: "text", access: "read" }), rw, "edit")).toBe(false);
    expect(canWrite(field({ name: "a", type: "text", read_only: true }), rw, "create")).toBe(false);
    expect(canWrite(field({ name: "a", type: "relation", create_only: true }), rw, "create")).toBe(true);
    expect(canWrite(field({ name: "a", type: "relation", create_only: true }), rw, "edit")).toBe(false);
    expect(readOnlyReason(field({ name: "a", type: "text", access: "read" }), rw, "edit")).toMatch(/role can view/);
    expect(readOnlyReason(field({ name: "a", type: "text", read_only: true }), rw, "edit")).toBe("Set by the system");
  });
});

describe("status moves", () => {
  const values = [{ key: "new", label: "New", category: "new" }, { key: "working", label: "Working", category: "working" },
    { key: "qualified", label: "Qualified", category: "qualified" }, { key: "disqualified", label: "Disqualified", category: "disqualified" },
    { key: "converted", label: "Converted", category: "converted" }];
  const lead = field({ name: "status", type: "status", values, operation_only_categories: ["converted"],
    category_transitions: { new: ["working", "qualified", "disqualified"], working: ["qualified", "disqualified"], qualified: ["working", "disqualified", "converted"], disqualified: ["working"], converted: [] } });

  it("offers a standard field's category moves, never an operation-only category", () => {
    expect(allowedStatuses(lead, "disqualified")).toEqual(["disqualified", "working"]);
    expect(allowedStatuses(lead, "qualified")).toEqual(["qualified", "working", "disqualified"]);
    expect(allowedStatuses(lead, undefined)).toEqual(["new", "working", "qualified", "disqualified"]);
  });

  it("offers a custom field's own transitions", () => {
    const f = field({ name: "s", type: "status", values: [{ key: "a", label: "A" }, { key: "b", label: "B" }, { key: "c", label: "C" }], transitions: { a: ["b"], b: ["a", "c"] } });
    expect(allowedStatuses(f, "a")).toEqual(["a", "b"]);
    expect(allowedStatuses(f, "c")).toEqual(["c"]);
  });
});

describe("form values", () => {
  it("round-trips every type between API values and form values", () => {
    const cases: [FieldType, unknown, unknown][] = [
      ["text", "  Ada ", "Ada"], ["long_text", "line 1\nline 2", "line 1\nline 2"], ["number", 42, 42], ["currency", 1234.5, 1234.5], ["boolean", true, true],
      ["date", "2026-11-16", "2026-11-16"], ["datetime", "2026-11-16T10:00:00.000Z", "2026-11-16T10:00:00.000Z"], ["single_select", "a", "a"],
      ["multi_select", ["a", "b"], ["a", "b"]], ["email", "a@b.co", "a@b.co"], ["phone", "+1 555", "+1 555"], ["url", "https://x.dev", "https://x.dev"],
      ["relation", "acct_1", "acct_1"], ["status", "open", "open"],
    ];
    for (const [type, api, back] of cases) expect(toApiValue(field({ name: "f", type }), toFormValue(field({ name: "f", type }), api)), type).toEqual(back);
  });

  it("turns empty input into null, and number text into numbers", () => {
    expect(toApiValue(field({ name: "f", type: "text" }), "   ")).toBeNull();
    expect(toApiValue(field({ name: "f", type: "number" }), "1,250.5")).toBe(1250.5);
    expect(toApiValue(field({ name: "f", type: "relation" }), "")).toBeNull();
    expect(toApiValue(field({ name: "f", type: "relation", relation: { to: "x", cardinality: "many_to_many" } }), ["a"])).toEqual(["a"]);
  });

  it("checks values as the server would, with readable messages", () => {
    const fs = [
      field({ name: "email", type: "email" }), field({ name: "site", type: "url" }), field({ name: "n", type: "number", validation: { min: 1, max: 5 } }),
      field({ name: "name", type: "text", required: true }), field({ name: "code", type: "text", validation: { max_length: 3, pattern: "^[A-Z]+$" } }),
      field({ name: "kind", type: "single_select", values: [{ key: "a", label: "A" }] }),
    ];
    const errors = validateValues(fs, { email: "nope", site: "javascript:alert(1)", n: 9, name: null, code: "abcd", kind: "zzz" }, "edit");
    expect(errors).toEqual({
      email: "Enter a valid email address", site: expect.stringMatching(/http/), n: "Must be at most 5", name: "Required", code: "Must be at most 3 characters", kind: "Pick one of the options",
    });
    expect(validateValues(fs, { email: "a@b.co", site: "https://ok.dev", n: 3, name: "x", code: "AB", kind: "a" }, "edit")).toEqual({});
    // A required field with a default may be left out on create.
    expect(validateValues([field({ name: "s", type: "status", required: true, initial: "open" })], { s: null }, "create")).toEqual({});
  });
});

describe("picking fields for screens", () => {
  const o = objectMeta({ name: "deal", fields: [
    field({ name: "name", type: "text" }), field({ name: "notes", type: "long_text" }), field({ name: "secret", type: "text", sensitivity: "restricted" }),
    field({ name: "hidden", type: "text", access: "none" }), field({ name: "amount", type: "currency" }), field({ name: "owner", type: "relation", relation: { to: "user", cardinality: "many_to_one" } }),
    field({ name: "stage", type: "relation", relation: { to: "stage", cardinality: "many_to_one" } }), field({ name: "account", type: "relation", relation: { to: "account", cardinality: "many_to_one" } }),
    field({ name: "tags", type: "relation", relation: { to: "tag", cardinality: "many_to_many" } }), field({ name: "status", type: "status", values: [] }),
  ], pipelines: [{ id: "p", name: "P", is_default: true, stages: [] }] });

  it("leaves hidden, restricted and long fields, and the naming field, out of default columns", () => {
    expect(defaultColumns(o)).toEqual(["amount", "owner", "stage", "account", "tags", "status"]);
  });
  it("includes people first, then records; pipelines and stages come from describe; never many-to-many", () => {
    expect(includable(o)).toEqual(["owner", "account"]);
  });
  it("shows statuses, stages, money and the owner as key facts", () => {
    expect(keyFacts(o).map((f) => f.name)).toEqual(["status", "stage", "amount", "owner"]);
  });
});
