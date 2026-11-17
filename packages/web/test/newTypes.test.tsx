import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { usePathOptions } from "@/features/list/FilterBuilder";
import { resolveList } from "@/features/list/listState";
import type { FieldMeta, ObjectMeta } from "@/lib/api/types";
import { compileWhere, fromWhere, parseSort } from "@/lib/filters";
import { fieldErrorsOf } from "@/lib/api/problem";
import { plainLabel } from "@/lib/text";
import {
  addressLine, canFilter, canSort, canWrite, defaultColumns, formatDuration, operatorsFor, parseDuration, partFields, readOnlyReason, sortableParts,
  toApiValue, toFormValue, validateValues, type FormValue,
} from "@/meta/fields";
import { FieldControl, FieldValue, FilterValueInput } from "@/meta/registry";
import { objectMeta, renderApp } from "./utils";

/**
 * Describe output for the five new types, copied from the real server (GET /v1/objects/:name, packages/server
 * core/describe.ts): parts are plain names (no display), json has no shape unless one is set, percent always
 * carries min/max (0/100 by default), duration has none, a rating's max defaults to 5.
 */
const ADDRESS: FieldMeta = { name: "hq", label: "Headquarters", type: "address", parts: ["line1", "line2", "city", "region", "postal_code", "country"], access: "write" };
const JSON_F: FieldMeta = { name: "settings", label: "Settings", type: "json", path_filters: true, access: "write" };
const JSON_SHAPED: FieldMeta = { name: "shaped", label: "Shaped", type: "json", shape: { type: "object", properties: { a: "string" } }, path_filters: true, access: "write" };
const RATING: FieldMeta = { name: "fit", label: "Fit", type: "rating", max: 5, access: "write" };
const RATING_10: FieldMeta = { name: "fit10", label: "Fit10", type: "rating", max: 10, access: "write" };
const PERCENT: FieldMeta = { name: "discount", label: "Discount", type: "percent", unit: "percent", min: 0, max: 100, access: "write" };
const PERCENT_WIDE: FieldMeta = { name: "disc2", label: "Disc2", type: "percent", validation: { max: 200, min: -50 }, unit: "percent", min: -50, max: 200, access: "write" };
const DURATION: FieldMeta = { name: "call_length", label: "Call Length", type: "duration", unit: "seconds", access: "write" };
const UNKNOWN: FieldMeta = { name: "geo", label: "Location", type: "geo_point", access: "write" };
const META: ObjectMeta = objectMeta({ name: "site", label: "Site", plural_label: "Sites", fields: [{ name: "name", label: "Name", type: "text", access: "write" }, ADDRESS, JSON_F, RATING, PERCENT, DURATION, UNKNOWN] });
const ACCESS = { read: true, write: true, archive: true };

function Editor({ f, initial }: { f: FieldMeta; initial: unknown }) {
  const [v, setV] = useState<FormValue>(() => toFormValue(f, initial));
  return <><FieldControl field={f} meta={META} mode="edit" value={v} onChange={setV} /><output data-testid="api">{JSON.stringify(toApiValue(f, v))}</output></>;
}
const api = () => JSON.parse(screen.getByTestId("api").textContent!) as unknown;

describe("address", () => {
  // A record's value as the server sends it: every part (null when empty) and a one-line display.
  const value = { line1: "1 Main St", line2: null, city: "Springfield", region: "IL", postal_code: "62701", country: "US", display: "1 Main St, Springfield, IL 62701, United States" };
  it("shows one compact line in a cell and the full address on a record", async () => {
    renderApp(<><div data-testid="cell"><FieldValue field={ADDRESS} value={value} /></div><div data-testid="full"><FieldValue field={ADDRESS} value={value} variant="full" /></div></>);
    expect(await screen.findByTestId("cell")).toHaveTextContent("1 Main St, Springfield, IL 62701, United States");
    const full = screen.getByTestId("full").querySelector("address")!;
    expect([...full.children].map((c) => c.textContent)).toEqual(["1 Main St", "Springfield, IL 62701", "United States"]);
    expect(addressLine({ city: "Paris", country: "FR" })).toBe("Paris, FR");
    expect(addressLine({ line1: null, line2: null, city: "Austin", region: null, postal_code: null, country: "US", display: "Austin, United States" })).toBe("Austin, United States");
  });
  it("edits as a group of parts with a country picker from the ISO list", async () => {
    renderApp(<Editor f={ADDRESS} initial={value} />);
    const group = await screen.findByRole("group", { name: "Headquarters" });
    expect(group).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("textbox", { name: "City" }));
    await userEvent.type(screen.getByRole("textbox", { name: "City" }), "Shelbyville");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Country" }), "CA");
    expect(api()).toMatchObject({ line1: "1 Main St", city: "Shelbyville", country: "CA" });
    expect(screen.getAllByRole("option").length).toBeGreaterThan(240);
    expect(validateValues([ADDRESS], { hq: { country: "XX" } }, "edit").hq).toBe("Choose a country from the list");
    expect(validateValues([ADDRESS], { hq: { country: "DE", city: "Berlin" } }, "edit")).toEqual({});
    // Each part's own limit, as the server's (line1 200, city 100, postal code 20).
    expect(validateValues([ADDRESS], { hq: { city: "x".repeat(101) } }, "edit").hq).toBe("City must be at most 100 characters");
    expect(validateValues([ADDRESS], { hq: { postal_code: "1".repeat(21) } }, "edit").hq).toBe("Postal code must be at most 20 characters");
    expect(validateValues([ADDRESS], { hq: { line1: "x".repeat(200) } }, "edit")).toEqual({});
  });
  it("filters by being empty; its parts filter, sort and compile as field.part", () => {
    expect(operatorsFor("address").map((o) => o.op)).toEqual(["empty", "not_empty"]);
    expect(canSort(ADDRESS)).toBe(false);
    expect(sortableParts(META).map((p) => p.name)).toContain("hq.city");
    const g = { kind: "group" as const, conj: "and" as const, children: [{ kind: "cond" as const, path: ["hq", "city"], op: "eq" as const, value: "Paris" }] };
    expect(compileWhere(g, partFields(META))).toEqual({ field: "hq.city", op: "eq", value: "Paris" });
    // A relation hop still compiles as a path.
    expect(compileWhere({ ...g, children: [{ ...g.children[0]!, path: ["account", "name"] }] }, partFields(META))).toEqual({ path: ["account", "name"], op: "eq", value: "Paris" });
    expect(fromWhere({ field: "hq.city", op: "eq", value: "Paris" })).toEqual(g);
    expect(parseSort("-hq.city,name")).toEqual([{ field: "hq.city", dir: "desc" }, { field: "name", dir: "asc" }]);
    expect(resolveList({ sort: "hq.city" }, META, [], null).sort).toEqual([{ field: "hq.city", dir: "asc" }]);
  });
  it("offers its parts in the filter builder", async () => {
    function Probe() {
      const { options } = usePathOptions(META);
      return <ul>{options.map((o) => <li key={o.key}>{o.key}</li>)}</ul>;
    }
    renderApp(<Probe />);
    expect(await screen.findByText("hq.city")).toBeInTheDocument();
    expect(screen.getByText("hq.country")).toBeInTheDocument();
  });
});

describe("json", () => {
  it("shows monospace JSON, edits in a checked textarea, filters only by being empty", async () => {
    renderApp(<><div data-testid="v"><FieldValue field={JSON_F} value={{ a: [1, 2] }} variant="full" /></div><Editor f={JSON_F} initial={{ a: 1 }} /></>);
    expect((await screen.findByTestId("v")).querySelector("pre")).toHaveTextContent('"a": [');
    const box = screen.getByRole("textbox");
    expect(box).toHaveClass("font-mono");
    fireEvent.change(box, { target: { value: '{"a": ' } });
    expect(screen.getByText(/Not valid JSON/)).toBeInTheDocument();
    expect(validateValues([JSON_F], { settings: toApiValue(JSON_F, '{"a": ') }, "edit").settings).toBe("This isn't valid JSON");
    fireEvent.change(box, { target: { value: '{"b": true}' } });
    expect(api()).toEqual({ b: true });
    expect(validateValues([JSON_F], { settings: { big: "x".repeat(17_000) } }, "edit").settings).toBe("Must be at most 16 KB of JSON");
    expect(operatorsFor("json").map((o) => o.op)).toEqual(["empty", "not_empty"]);
    expect(canSort(JSON_F)).toBe(false);
    expect(canSort(JSON_SHAPED)).toBe(false);
    expect(defaultColumns(META)).not.toContain("settings");
  });
});

describe("rating", () => {
  it("shows stars, edits as a radio group by keyboard, filters and sorts as a number", async () => {
    renderApp(<><div data-testid="v"><FieldValue field={RATING} value={3} /></div><Editor f={RATING} initial={2} /></>);
    expect(await screen.findByRole("img", { name: "3 out of 5" })).toBeInTheDocument();
    const group = screen.getByRole("radiogroup", { name: "Fit" });
    expect(group).toBeInTheDocument();
    const two = screen.getByRole("radio", { name: "2 of 5" });
    expect(two).toHaveAttribute("aria-checked", "true");
    two.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(api()).toBe(3);
    await userEvent.keyboard("{End}");
    expect(api()).toBe(5);
    await userEvent.keyboard("{Delete}");
    expect(api()).toBeNull();
    expect(validateValues([RATING], { fit: 6 }, "edit").fit).toBe("Choose 1 to 5");
    expect(validateValues([RATING_10], { fit10: 10 }, "edit")).toEqual({});
    expect(validateValues([RATING_10], { fit10: 11 }, "edit").fit10).toBe("Choose 1 to 10");
    expect(operatorsFor("rating").map((o) => o.op)).toContain("gte");
    expect(canSort(RATING)).toBe(true);
  });
});

describe("percent", () => {
  it("shows a % suffix, takes a number with bounds", async () => {
    renderApp(<><div data-testid="v"><FieldValue field={PERCENT} value={12.5} /></div><Editor f={PERCENT} initial={10} /></>);
    expect(await screen.findByTestId("v")).toHaveTextContent("12.5%");
    await userEvent.clear(screen.getByRole("textbox"));
    await userEvent.type(screen.getByRole("textbox"), "15");
    expect(api()).toBe(15);
    expect(validateValues([PERCENT], { discount: 101 }, "edit").discount).toBe("Must be at most 100%");
    expect(validateValues([PERCENT], { discount: -1 }, "edit").discount).toBe("Must be at least 0%");
    expect(validateValues([PERCENT], { discount: 12.3456 }, "edit")).toEqual({});
    expect(validateValues([PERCENT], { discount: 12.34567 }, "edit").discount).toBe("Use at most 4 decimal places");
    expect(validateValues([PERCENT_WIDE], { disc2: -50 }, "edit")).toEqual({});
    expect(validateValues([PERCENT_WIDE], { disc2: 150 }, "edit")).toEqual({});
    expect(validateValues([PERCENT_WIDE], { disc2: 201 }, "edit").disc2).toBe("Must be at most 200%");
    expect(canSort(PERCENT)).toBe(true);
  });
});

describe("duration", () => {
  it("shows 1d 2h 3m, takes '1h 30m' or seconds", async () => {
    expect(formatDuration(93_780)).toBe("1d 2h 3m");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(5400)).toBe("1h 30m");
    for (const [t, n] of [["1h 30m", 5400], ["90m", 5400], ["5400", 5400], ["2d", 172_800], ["1.5h", 5400], ["45 s", 45], ["1 hour 2 minutes", 3720]] as const) expect(parseDuration(t), t).toBe(n);
    for (const t of ["soon", "1x", "h"]) expect(parseDuration(t), t).toBeNull();
    renderApp(<><div data-testid="v"><FieldValue field={DURATION} value={5400} /></div><Editor f={DURATION} initial={60} /></>);
    expect(await screen.findByTestId("v")).toHaveTextContent("1h 30m");
    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("1m");
    await userEvent.clear(input);
    await userEvent.type(input, "1h 30m");
    expect(api()).toBe(5400);
    expect(screen.getByText(/5,?400 seconds/)).toBeInTheDocument();
    expect(validateValues([DURATION], { call_length: toApiValue(DURATION, "whenever") }, "edit").call_length).toMatch(/duration/);
    // No min/max from describe: 0 up to the server's limit, and a field's own validation when it has one.
    expect(validateValues([DURATION], { call_length: 0 }, "edit")).toEqual({});
    expect(validateValues([DURATION], { call_length: 1e11 + 1 }, "edit").call_length).toMatch(/longest duration/);
    expect(validateValues([{ ...DURATION, validation: { max: 3600 } }], { call_length: 3601 }, "edit").call_length).toBe("Must be at most 1h");
  });
  it("filters by a duration typed in words, sent as seconds", async () => {
    let sent: unknown;
    renderApp(<FilterValueInput field={DURATION} op="gt" value={undefined} ariaLabel="Condition value" onChange={(v) => (sent = v)} />);
    await userEvent.type(await screen.findByRole("textbox", { name: "Condition value" }), "2h");
    expect(sent).toBe(7200);
  });
});

describe("the server's refusals", () => {
  it("puts a 422's per-field messages on the new types' fields", () => {
    // As POST /v1/objects/site/records answers bad values (captured from the server).
    const errors = { errors: [{ field: "hq", message: "city must be at most 100 characters" }, { field: "fit", message: "must be a whole number from 1 to 5" },
      { field: "discount", message: "must be between 0 and 100 (percent)" }, { field: "call_length", message: "must be from 0 to 100000000000 seconds" }] };
    expect(fieldErrorsOf(errors)).toEqual({ hq: "city must be at most 100 characters", fit: "must be a whole number from 1 to 5",
      discount: "must be between 0 and 100 (percent)", call_length: "must be from 0 to 100000000000 seconds" });
  });
});

describe("a field type this version doesn't know", () => {
  it("shows the raw value read-only as text, no editor, 'is empty' only, never sorted", async () => {
    renderApp(<div data-testid="v"><FieldValue field={UNKNOWN} value={{ lat: 1.5, lng: 2 }} /></div>);
    expect(await screen.findByTestId("v")).toHaveTextContent('{"lat":1.5,"lng":2}');
    expect(canWrite(UNKNOWN, ACCESS, "edit")).toBe(false);
    expect(canWrite(UNKNOWN, ACCESS, "create")).toBe(false);
    expect(readOnlyReason(UNKNOWN, ACCESS, "edit")).toMatch(/can't be edited in this version/);
    expect(operatorsFor(UNKNOWN.type).map((o) => o.op)).toEqual(["empty", "not_empty"]);
    expect(canSort(UNKNOWN)).toBe(false);
    expect(canFilter(UNKNOWN)).toBe(true);
    // No validation surprises either.
    expect(validateValues([UNKNOWN], { geo: { lat: 1 } }, "edit")).toEqual({});
  });
});

describe("bidirectional text", () => {
  it("isolates values and strips controls from labels", async () => {
    const SELECT: FieldMeta = { name: "kind", label: "Kind", type: "single_select", access: "read", values: [{ key: "a", label: "Alpha" }] };
    renderApp(<p data-testid="v">File: <FieldValue field={SELECT} value={"‮exe.txt"} /> and <FieldValue field={{ name: "n", label: "N", type: "text" }} value={"‮abc"} /></p>);
    const p = await screen.findByTestId("v");
    // The unknown select key is a label: no override left in it.
    expect(p.textContent).toContain("exe.txt");
    expect(p.textContent).not.toContain("‮exe.txt");
    // Free text keeps its characters but is isolated from what's around it.
    expect(p.querySelectorAll("bdi").length).toBeGreaterThanOrEqual(2);
    expect(plainLabel("‮evil⁦ label‏")).toBe("evil label");
  });
});
