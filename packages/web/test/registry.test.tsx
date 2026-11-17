import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FieldType, RecordData } from "@/lib/api/types";
import { FieldControl, FieldValue } from "@/meta/registry";
import { field, objectMeta, renderApp } from "./utils";

const meta = objectMeta({ name: "thing", fields: [] });

describe("field registry: reading values", () => {
  const rec: RecordData = { id: "thg_1", object: "thing", currency: "EUR", included: { account: { id: "acct_1", object: "account", display_name: "Acme" }, owner: { id: "usr_1", object: "user", display_name: "Ada Lovelace" }, hidden: { id: "sec_1", object: "secret", display_name: null } } };
  const cases: [string, FieldType, unknown, (c: HTMLElement) => void][] = [
    ["text", "text", "Hello", (c) => expect(c).toHaveTextContent("Hello")],
    ["long text, first line in a cell", "long_text", "one\ntwo", (c) => expect(c).toHaveTextContent(/^one$/)],
    ["number", "number", 1234.5, (c) => expect(c.textContent).toMatch(/1.?234/)],
    ["currency in the record's currency", "currency", 99, (c) => expect(c.textContent).toMatch(/€|EUR/)],
    ["boolean", "boolean", true, (c) => expect(c).toHaveTextContent("Yes")],
    ["date without time-zone shift", "date", "2026-01-01", (c) => expect(c.textContent).toMatch(/2026/)],
    ["date-time", "datetime", "2026-01-01T10:00:00Z", (c) => expect(c.querySelector("time")).toHaveAttribute("datetime", "2026-01-01T10:00:00Z")],
    ["select label", "single_select", "a", (c) => expect(c).toHaveTextContent("Alpha")],
    ["multi-select labels", "multi_select", ["a", "b"], (c) => expect(c).toHaveTextContent("AlphaBeta")],
    ["status label", "status", "a", (c) => expect(c).toHaveTextContent("Alpha")],
    ["email as mailto", "email", "a@b.co", (c) => expect(c.querySelector("a")).toHaveAttribute("href", "mailto:a@b.co")],
    ["phone as tel", "phone", "+1 555 0100", (c) => expect(c.querySelector("a")).toHaveAttribute("href", "tel:+15550100")],
    ["url, safe schemes only", "url", "javascript:alert(1)", (c) => expect(c.querySelector("a")).toBeNull()],
  ];
  for (const [name, type, value, check] of cases) {
    it(name, async () => {
      const f = field({ name: "f", type, values: [{ key: "a", label: "Alpha" }, { key: "b", label: "Beta" }] });
      renderApp(<div data-testid="v"><FieldValue field={f} value={value} record={rec} meta={meta} /></div>);
      check(await screen.findByTestId("v"));
    });
  }
  it("relations: the related record's name, linked", async () => {
    renderApp(<div data-testid="v"><FieldValue field={field({ name: "account", type: "relation", relation: { to: "account", cardinality: "many_to_one" } })} value="acct_1" record={rec} /></div>);
    const link = await screen.findByRole("link", { name: "Acme" });
    expect(link).toHaveAttribute("href", "/o/account/acct_1");
  });
  it("relations to members show their name; to unreadable objects, not visible", async () => {
    renderApp(<div>
      <FieldValue field={field({ name: "owner", type: "relation", relation: { to: "user", cardinality: "many_to_one" } })} value="usr_1" record={rec} />
      <FieldValue field={field({ name: "hidden", type: "relation", relation: { to: "secret", cardinality: "many_to_one" } })} value="sec_1" record={rec} />
    </div>);
    expect(await screen.findByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Not visible")).toBeInTheDocument();
  });
  it("restricted values and empty values", async () => {
    renderApp(<div><span data-testid="r"><FieldValue field={field({ name: "s", type: "text" })} value="[restricted]" /></span><span data-testid="e"><FieldValue field={field({ name: "s", type: "text" })} value={null} /></span></div>);
    expect(await screen.findByTestId("r")).toHaveTextContent("Restricted");
    expect(screen.getByTestId("e")).toHaveTextContent("—");
  });
});

describe("field registry: controls", () => {
  const control = (type: FieldType, extra = {}) => renderApp(
    <FieldControl field={field({ name: "f", type, values: [{ key: "a", label: "Alpha" }, { key: "b", label: "Beta" }], ...extra })} meta={meta} mode="edit" value={null} onChange={() => {}} id="c" />,
  );
  it.each([
    ["text", "textbox"], ["email", "textbox"], ["url", "textbox"], ["phone", "textbox"], ["number", "textbox"], ["currency", "textbox"],
    ["long_text", "textbox"], ["single_select", "combobox"], ["status", "combobox"], ["boolean", "switch"],
  ] as [FieldType, string][])("%s uses a %s", async (type, role) => {
    control(type);
    expect(await screen.findByRole(role)).toBeInTheDocument();
  });
  it("dates use date inputs; multi-selects are toggle buttons", async () => {
    const { container } = control("date");
    await screen.findByRole("textbox", { hidden: true }).catch(() => null);
    expect(container.querySelector('input[type="date"]')).not.toBeNull();
    control("multi_select");
    expect(await screen.findByRole("button", { name: "Alpha" })).toHaveAttribute("aria-pressed", "false");
  });
  it("status offers only the moves allowed from the current value", async () => {
    renderApp(<FieldControl field={field({ name: "f", type: "status", values: [{ key: "a", label: "Alpha" }, { key: "b", label: "Beta" }, { key: "c", label: "Gamma" }], transitions: { a: ["b"] } })}
      meta={meta} mode="edit" value="a" record={{ id: "x", object: "t", f: "a" }} onChange={() => {}} />);
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["Alpha", "Beta"]);
  });
  it("relations edit through a search picker", async () => {
    control("relation", { relation: { to: "account", cardinality: "many_to_one" } });
    expect(await screen.findByText("Choose…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /choose/i })).toHaveAttribute("aria-haspopup", "listbox");
  });
});
