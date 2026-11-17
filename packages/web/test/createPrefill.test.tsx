import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CreateRecordDialog } from "@/features/create/CreateRecordDialog";
import type { FieldAccess } from "@/lib/api/types";
import { field, objectMeta, renderApp, type Call } from "./utils";

/** A new deal from a contact's page (or with a contact chosen) starts with that contact's account, read with the caller's own access. */

const deal = objectMeta({ name: "deal", label: "Deal", plural_label: "Deals", standard: true,
  description: "A qualified opportunity in a pipeline. Change its stage with move_deal_stage.", fields: [
    field({ name: "name", type: "text", required: true }),
    field({ name: "account", label: "Account", type: "relation", relation: { to: "account", cardinality: "many_to_one" } }),
    field({ name: "primary_contact", label: "Primary contact", type: "relation", required: true, relation: { to: "contact", cardinality: "many_to_one" } }),
    field({ name: "stage", label: "Stage", type: "relation", relation: { to: "stage", cardinality: "many_to_one" },
      description: "Stage ID or stage name. Defaults to the pipeline's first stage. Change later with move_deal_stage." }),
    ...["amount", "expected_close_date", "probability", "lost_reason", "next_step", "source", "notes"].map((name) => field({ name, type: "text" })),
  ] });
const contact = (access: FieldAccess) => objectMeta({ name: "contact", label: "Contact", plural_label: "Contacts", standard: true, fields: [
  field({ name: "first_name", type: "text" }),
  field({ name: "account", type: "relation", access, relation: { to: "account", cardinality: "many_to_one" } }),
] });

function handler(access: FieldAccess, created: Call[]) {
  return (c: Call) => {
    if (c.path === "/v1/objects/deal" && c.method === "GET") return { body: { data: deal } };
    if (c.path === "/v1/objects/contact" && c.method === "GET") return { body: { data: contact(access) } };
    // The API leaves out what the caller's role can't read.
    if (c.path === "/v1/objects/contact/records/con_1") return { body: { data: { id: "con_1", object: "contact", display_name: "Ada", ...(access === "none" ? {} : { account: "acct_7" }) } } };
    if (c.path === "/v1/objects/deal/records" && c.method === "POST") {
      created.push(c);
      return { status: 201, body: { data: { id: "deal_1", object: "deal", display_name: "New deal" } } };
    }
    if (c.path.startsWith("/v1/objects/account/records")) return { body: { data: [{ id: "acct_7", object: "account", display_name: "Acme" }], next_cursor: null } };
    return undefined;
  };
}

async function createDeal(access: FieldAccess, prefill: Record<string, unknown>) {
  const created: Call[] = [];
  const view = renderApp(<CreateRecordDialog object="deal" open onOpenChange={() => {}} prefill={prefill} stay />, handler(access, created));
  await screen.findByRole("dialog", { name: "New deal" });
  return { created, calls: view.calls };
}

describe("a new deal with a contact chosen", () => {
  it("starts with the contact's account, shown up front and sent unless changed", async () => {
    const { created } = await createDeal("read", { primary_contact: "con_1" });
    // The account field joins the fields shown first once it is filled in.
    expect(await screen.findByText("Account")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: /name/i }), "Pilot");
    await userEvent.click(screen.getByRole("button", { name: "Create deal" }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.body).toMatchObject({ name: "Pilot", primary_contact: "con_1", account: "acct_7" });
  });

  it("copies nothing when the caller's role can't read the contact's account", async () => {
    const { created, calls } = await createDeal("none", { primary_contact: "con_1" });
    await userEvent.type(screen.getByRole("textbox", { name: /name/i }), "Pilot");
    await userEvent.click(screen.getByRole("button", { name: "Create deal" }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.body).not.toHaveProperty("account");
    expect(calls.some((c) => c.path === "/v1/objects/contact/records/con_1")).toBe(false);
  });

  it("never replaces an account the person (or the caller) chose", async () => {
    const { created } = await createDeal("read", { primary_contact: "con_1", account: "acct_mine" });
    await userEvent.type(screen.getByRole("textbox", { name: /name/i }), "Pilot");
    await userEvent.click(screen.getByRole("button", { name: "Create deal" }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]!.body).toMatchObject({ account: "acct_mine" });
  });

  it("describes the deal and its stage in words, not operation names", async () => {
    await createDeal("read", { primary_contact: "con_1" });
    const dialog = screen.getByRole("dialog", { name: "New deal" });
    expect(dialog).not.toHaveTextContent(/move_deal_stage|convert_lead|Stage ID/);
    expect(dialog).toHaveTextContent("Change its stage on the deal's page or on the Deals board.");
  });
});
