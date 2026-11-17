import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { field, objectMeta, renderRoute, type Call } from "./utils";

const CONTACT = objectMeta({ name: "contact", label: "Contact", plural_label: "Contacts", standard: true, fields: [field({ name: "first_name", type: "text" }), field({ name: "job_title", type: "text" })] });
const OBJECTS = [{ name: "contact", label: "Contact", plural_label: "Contacts", standard: true, access: { read: true, write: true, archive: true }, id_prefix: "con", owned: true, field_count: 2 }];
const rows = { data: [{ id: "con_1", object: "contact", display_name: "Ada Arden", first_name: "Ada", version: 1 }], next_cursor: null, total: 1 };

function api(views: unknown[], opts: { failView?: boolean } = {}) {
  return (c: Call) => {
    if (c.path === "/v1/me/preferences" && c.method === "GET") return { body: { data: { "list.contact": { view: "v_gone" } } } };
    if (c.path === "/v1/me/preferences" && c.method === "PUT") return { body: { data: c.body } };
    if (c.path === "/v1/objects/contact") return { body: { data: CONTACT } };
    if (c.path === "/v1/objects/contact/views") return { body: { data: views } };
    if (c.path === "/v1/query") {
      if (opts.failView && (c.body as { view?: string }).view) return { status: 422, body: { code: "view_invalid", detail: "View v_gone refers to field nickname, which no longer exists" } };
      return { body: rows };
    }
    return undefined;
  };
}

describe("a remembered view that no longer works", () => {
  it("is dropped (here and in the preference) for the default list, with one plain note and no view ID", async () => {
    const { calls, router } = renderRoute("/o/contact", api([]), { objects: OBJECTS });
    expect(await screen.findByRole("status")).toHaveTextContent("Your last view isn't available any more, so you're seeing all contacts.");
    expect(await screen.findByText("1 contact")).toBeInTheDocument();
    expect(router.state.location.search).toEqual({});
    await waitFor(() => expect(calls.some((c) => c.method === "PUT" && c.path === "/v1/me/preferences" && JSON.stringify(c.body).includes('"view":null'))).toBe(true));
    expect(document.body.textContent).not.toContain("v_gone");
  });

  it("is dropped when the server refuses it as broken, naming it by its name", async () => {
    const view = { id: "v_gone", object: "contact", name: "Old nicknames", shared: false, owner: "usr_ME", mine: true, status: "ok", version: 1 };
    renderRoute("/o/contact", api([view], { failView: true }), { objects: OBJECTS });
    expect(await screen.findByRole("status")).toHaveTextContent("Your last view, “Old nicknames”, can't be shown any more");
    expect(await screen.findByText("1 contact")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("v_gone");
  });

  it("a broken view opened from a link says so plainly, without its ID", async () => {
    const handler = api([], { failView: true });
    renderRoute("/o/contact?view=v_gone", (c) => (c.path === "/v1/me/preferences" && c.method === "GET" ? { body: { data: {} } } : handler(c)), { objects: OBJECTS });
    expect(await screen.findByText("This view can't be shown")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show all contacts" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("v_gone");
  });
});
