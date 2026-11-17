import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderRoute, SESSION } from "./utils";

const LIMITED = { ...SESSION, role: "field_limited", permissions: ["records:read", "records:write"] };

describe("pages a role doesn't reach", () => {
  for (const [path, title] of [
    ["/settings/audit", "You don't have access to audit log"],
    ["/settings/api-keys", "You don't have access to api keys"],
    ["/settings/members", "You don't have access to members"],
    ["/settings/webhooks/wh_1", "You don't have access to webhooks"],
    ["/settings/workspace", "You don't have access to workspace sign-in"],
  ] as const) {
    it(`${path}: one clear state, no actions, no requests that would be refused`, async () => {
      const { calls } = renderRoute(path, () => undefined, { session: LIMITED });
      expect(await screen.findByText(title)).toBeInTheDocument();
      const main = screen.getByText(title).closest("div.max-w-4xl") as HTMLElement;
      expect(within(main).queryAllByRole("button")).toHaveLength(0);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(calls.some((c) => /\/v1\/(audit-log|api-keys|members|webhooks)/.test(c.path))).toBe(false);
    });
  }

  it("the deals board for a role that can't read deals: one message", async () => {
    renderRoute("/board", (c) => (c.path === "/v1/objects/deal" ? { status: 403, body: { code: "forbidden", detail: 'This key lacks the "records:read" permission on every object' } } : undefined), { session: LIMITED });
    expect(await screen.findByText("You don't have access to deals")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new deal/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/can view deals but not move/i)).not.toBeInTheDocument();
  });
});
