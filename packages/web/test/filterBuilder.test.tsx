import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FilterBuilder } from "@/features/list/FilterBuilder";
import { compileWhere, emptyGroup, type Group } from "@/lib/filters";
import { field, objectMeta, renderApp } from "./utils";

const deal = objectMeta({ name: "deal", fields: [
  field({ name: "name", type: "text" }), field({ name: "amount", type: "currency" }),
  field({ name: "status", type: "single_select", values: [{ key: "open", label: "Open" }, { key: "won", label: "Won" }] }),
  field({ name: "account", type: "relation", relation: { to: "account", cardinality: "many_to_one" } }), field({ name: "secret", type: "text", sensitivity: "restricted" }),
] });
const account = objectMeta({ name: "account", label: "Account", fields: [field({ name: "industry", type: "text" }), field({ name: "hidden", type: "text", access: "none" })] });

function Harness({ onChange }: { onChange: (g: Group) => void }) {
  return <FilterBuilder meta={deal} value={emptyGroup()} onChange={onChange} />;
}

describe("filter builder", () => {
  const handler = ({ path }: { path: string }) => (path === "/v1/objects/account" ? { body: { data: account } } : undefined);

  it("adds a condition with the first field and a type-appropriate operator", async () => {
    const onChange = vi.fn();
    renderApp(<Harness onChange={onChange} />, handler);
    await userEvent.click(await screen.findByRole("button", { name: /add condition/i }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: "group", conj: "and", children: [{ kind: "cond", path: ["name"], op: "contains" }] });
  });

  it("offers this object's fields and one hop through relations, never restricted or hidden ones", async () => {
    const value: Group = { kind: "group", conj: "and", children: [{ kind: "cond", path: ["name"], op: "contains", value: "x" }] };
    renderApp(<FilterBuilder meta={deal} value={value} onChange={() => {}} />, handler);
    const select = await screen.findByRole("combobox", { name: "Condition 1 field" });
    await waitFor(() => expect(select.querySelectorAll("option").length).toBeGreaterThan(5));
    const labels = [...select.querySelectorAll("option")].map((o) => o.textContent);
    expect(labels).toContain("account → industry");
    expect(labels).not.toContain("secret");
    expect(labels.join()).not.toContain("hidden");
  });

  it("switching field resets an incompatible operator; operators follow the type", async () => {
    let current: Group = { kind: "group", conj: "and", children: [{ kind: "cond", path: ["name"], op: "contains", value: "acme" }] };
    const onChange = vi.fn((g: Group) => { current = g; });
    const { rerender } = renderApp(<FilterBuilder meta={deal} value={current} onChange={onChange} />, handler);
    fireEvent.change(await screen.findByRole("combobox", { name: "Condition 1 field" }), { target: { value: "amount" } });
    expect(current.children[0]).toEqual({ kind: "cond", path: ["amount"], op: "eq" });
    rerender(<></>);
    renderApp(<FilterBuilder meta={deal} value={current} onChange={onChange} />, handler);
    const ops = [...(await screen.findAllByRole("combobox", { name: "Condition 1 operator" })).at(-1)!.querySelectorAll("option")].map((o) => o.getAttribute("value"));
    expect(ops).toEqual(["eq", "neq", "gt", "gte", "lt", "lte", "empty", "not_empty"]);
  });

  it("builds AND/OR groups that compile to the API's where", async () => {
    let current: Group = { kind: "group", conj: "and", children: [{ kind: "cond", path: ["status"], op: "eq", value: "open" }] };
    const onChange = (g: Group) => { current = g; };
    renderApp(<FilterBuilder meta={deal} value={current} onChange={onChange} />, handler);
    fireEvent.change(await screen.findByRole("combobox", { name: "Match all or any conditions" }), { target: { value: "or" } });
    expect(current.conj).toBe("or");
    current = { ...current, children: [...current.children, { kind: "cond", path: ["account", "industry"], op: "eq", value: "Software" }] };
    expect(compileWhere(current)).toEqual({ or: [{ field: "status", op: "eq", value: "open" }, { path: ["account", "industry"], op: "eq", value: "Software" }] });
  });
});
