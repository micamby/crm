import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DataTable, toggleSort } from "@/features/list/DataTable";
import { ApiProblem } from "@/lib/api/problem";
import type { RecordData, Sort } from "@/lib/api/types";
import { field, objectMeta, renderApp } from "./utils";

// The virtualizer measures its scroll box; give jsdom one.
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 800 });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 1200 });

const meta = objectMeta({ name: "contact", label: "Contact", plural_label: "Contacts", fields: [
  field({ name: "email", type: "email" }), field({ name: "score", type: "number" }), field({ name: "locked", type: "text", access: "read" }),
  field({ name: "notes", type: "long_text" }),
] });
const rows: RecordData[] = Array.from({ length: 3000 }, (_, i) => ({ id: `con_${i}`, object: "contact", display_name: `Person ${i}`, version: 1, email: `p${i}@x.co`, score: i, locked: "x" }));

function Harness(p: { onEdit?: (r: RecordData, f: { name: string }, v: unknown) => Promise<void>; onSort?: (s: Sort[]) => void; onLoadMore?: () => void }) {
  const [sel, setSel] = useState({});
  const [sort, setSort] = useState<Sort[]>([]);
  return (
    <div style={{ height: 800 }}>
      <DataTable meta={meta} rows={rows} columns={["email", "score", "locked"]} sort={sort} onSortChange={(s) => { setSort(s); p.onSort?.(s); }}
        selection={sel} onSelectionChange={setSel} onEdit={p.onEdit as never} loading={false} hasMore loadingMore={false} onLoadMore={p.onLoadMore ?? (() => {})} total={3000} />
      <output data-testid="sel">{Object.keys(sel).length}</output>
    </div>
  );
}

describe("records table", () => {
  it("renders only the rows in view out of thousands, as a grid", async () => {
    renderApp(<Harness />);
    const grid = await screen.findByRole("grid", { name: "Contacts" });
    expect(grid).toHaveAttribute("aria-rowcount", "3001");
    const rendered = within(grid).getAllByRole("row");
    expect(rendered.length).toBeGreaterThan(5);
    expect(rendered.length).toBeLessThan(100);
    expect(within(grid).getByRole("link", { name: "Person 0" })).toHaveAttribute("href", "/o/contact/con_0");
  });

  it("sorts by a header click, adds keys with shift (up to three), and never sorts long text", async () => {
    const onSort = vi.fn();
    renderApp(<Harness onSort={onSort} />);
    await userEvent.click(await screen.findByRole("button", { name: /email/i }));
    expect(onSort).toHaveBeenLastCalledWith([{ field: "email", dir: "asc" }]);
    fireEvent.click(screen.getByRole("button", { name: /score/i }), { shiftKey: true });
    expect(onSort).toHaveBeenLastCalledWith([{ field: "email", dir: "asc" }, { field: "score", dir: "asc" }]);
    expect(screen.getAllByRole("columnheader").find((h) => h.textContent?.includes("email"))).toHaveAttribute("aria-sort", "ascending");
    expect(toggleSort([{ field: "a", dir: "asc" }], "a", false)).toEqual([{ field: "a", dir: "desc" }]);
    expect(toggleSort([{ field: "a", dir: "desc" }], "a", false)).toEqual([]);
    expect(toggleSort([{ field: "a" }, { field: "b" }, { field: "c" }], "d", true)).toHaveLength(3);
  });

  it("moves between cells with the arrow keys and selects a row with Space", async () => {
    renderApp(<Harness />);
    const grid = await screen.findByRole("grid");
    fireEvent.focus(grid.querySelector<HTMLElement>('[data-cell="0:1"]')!);
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement?.getAttribute("data-cell")).toBe("0:2"));
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement?.getAttribute("data-cell")).toBe("1:2"));
    fireEvent.keyDown(grid, { key: " " });
    expect(screen.getByTestId("sel")).toHaveTextContent("1");
  });

  it("edits a writable cell in place (Enter), saves through onEdit, and keeps read-only cells closed", async () => {
    const onEdit = vi.fn(async () => {});
    renderApp(<Harness onEdit={onEdit} />);
    const grid = await screen.findByRole("grid");
    fireEvent.focus(grid.querySelector<HTMLElement>('[data-cell="0:2"]')!);
    fireEvent.keyDown(grid, { key: "Enter" });
    const input = await screen.findByDisplayValue("p0@x.co");
    await userEvent.clear(input);
    await userEvent.type(input, "new@x.co{Enter}");
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith(rows[0], expect.objectContaining({ name: "email" }), "new@x.co"));
    // The read-only column (role access "read") never opens an editor.
    fireEvent.focus(grid.querySelector<HTMLElement>('[data-cell="0:4"]')!);
    fireEvent.keyDown(grid, { key: "Enter" });
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("shows the server's message when an edit is refused", async () => {
    const onEdit = vi.fn(async () => { throw new ApiProblem({ status: 422, code: "validation_failed", detail: "Invalid", errors: { errors: [{ field: "score", message: "must be at most 10" }] } }); });
    renderApp(<Harness onEdit={onEdit} />);
    const grid = await screen.findByRole("grid");
    fireEvent.doubleClick(grid.querySelector<HTMLElement>('[data-cell="0:3"]')!);
    const input = await screen.findByDisplayValue("0");
    await userEvent.type(input, "99{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Must be at most 10");
  });
});
