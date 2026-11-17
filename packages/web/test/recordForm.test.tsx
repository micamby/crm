import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CreateRecordDialog } from "@/features/create/CreateRecordDialog";
import { field, objectMeta, renderApp, type Call } from "./utils";

const project = objectMeta({ name: "project", label: "Project", plural_label: "Projects", description: "Work we do", fields: [
  field({ name: "title", type: "text", required: true }),
  field({ name: "budget", type: "currency", validation: { min: 0 } }),
  field({ name: "client", type: "relation", relation: { to: "account", cardinality: "many_to_one" } }),
  field({ name: "stage", type: "status", values: [{ key: "idea", label: "Idea" }, { key: "live", label: "Live" }], initial: "idea" }),
  field({ name: "kind", type: "single_select", values: [{ key: "a", label: "A" }], default: "a" }),
  field({ name: "computed", type: "number", read_only: true }),
  field({ name: "secret", type: "text", access: "none" }),
  field({ name: "frozen", type: "text", access: "read" }),
] });

function handler(onCreate: (c: Call) => { status?: number; body?: unknown }) {
  return (c: Call) => {
    if (c.path === "/v1/objects/project" && c.method === "GET") return { body: { data: project } };
    if (c.path === "/v1/objects/project/records" && c.method === "POST") return onCreate(c);
    if (c.path === "/v1/objects/account/records") return { body: { data: [{ id: "acct_1", object: "account", display_name: "Acme" }], next_cursor: null } };
    return undefined;
  };
}

describe("create record form", () => {
  it("is built from describe: required fields first, defaults applied, hidden and system fields absent", async () => {
    renderApp(<CreateRecordDialog object="project" open onOpenChange={() => {}} stay />, handler(() => ({ status: 201 })));
    expect(await screen.findByRole("dialog", { name: "New project" })).toBeInTheDocument();
    const title = screen.getByRole("textbox", { name: /title/i });
    expect(title).toHaveFocus();
    expect(screen.getByRole("combobox", { name: /kind/i })).toHaveValue("a");
    expect(screen.queryByText("computed")).not.toBeInTheDocument();
    expect(screen.queryByText("secret")).not.toBeInTheDocument();
    expect(screen.queryByText("frozen")).not.toBeInTheDocument();
  });

  it("checks required values before sending, then puts the server's messages on their fields", async () => {
    const calls: Call[] = [];
    renderApp(<CreateRecordDialog object="project" open onOpenChange={() => {}} stay />, handler((c) => {
      calls.push(c);
      return { status: 422, body: { code: "validation_failed", detail: "Invalid project: budget must be at least 0", errors: { errors: [{ field: "budget", message: "must be at least 0" }] } } };
    }));
    await userEvent.click(await screen.findByRole("button", { name: "Create project" }));
    expect(await screen.findByText("Required")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    await userEvent.type(screen.getByRole("textbox", { name: /title/i }), "Website");
    await userEvent.type(screen.getByRole("textbox", { name: /budget/i }), "5");
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    expect(await screen.findByText("Must be at least 0")).toBeInTheDocument();
    expect(calls[0]!.body).toEqual({ title: "Website", budget: 5, kind: "a" });
    expect(calls[0]!.headers["x-csrf-token"]).toBe("csrf-1");
  });

  it("creates the record with a relation picked by search", async () => {
    const calls: Call[] = [];
    renderApp(<CreateRecordDialog object="project" open onOpenChange={() => {}} stay />, handler((c) => {
      calls.push(c);
      return { status: 201, body: { data: { id: "prj_1", object: "project", display_name: "Website" } } };
    }));
    await userEvent.type(await screen.findByRole("textbox", { name: /title/i }), "Website");
    await userEvent.click(screen.getByRole("button", { name: /client/i }));
    await userEvent.click(await screen.findByRole("option", { name: /Acme/ }));
    await userEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(calls[0]!.body).toEqual({ title: "Website", client: "acct_1", kind: "a" }));
  });
});
