import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ApiKeysSettings } from "@/features/settings/ApiKeysSettings";
import { renderApp, SESSION } from "./utils";

const SECRET = "hlcrm_live_abcd_SECRET_VALUE_1234567890";
const OWNER = { ...SESSION, permissions: [...SESSION.permissions, "keys:manage", "members:manage"] };
const KEY = { id: "key_1", name: "Billing sync", owner: "usr_ME", scopes: ["ops:read"], environment: "live", hint: "hlcrm_live_abcd…", created_at: "2026-01-01T00:00:00Z", expires_at: null, revoked_at: null, last_used_at: null };

describe("secrets shown once", () => {
  it("leave no copy in the query or mutation caches once the dialog is closed (create and rotate)", async () => {
    const { qc } = renderApp(<ApiKeysSettings />, (c) => {
      if (c.path === "/v1/api-keys" && c.method === "GET") return { body: { data: [KEY] } };
      if (c.path === "/v1/members") return { body: { data: { users: [], service_accounts: [] } } };
      if (c.path === "/v1/api-keys" && c.method === "POST") return { status: 201, body: { data: { id: "key_2", secret: SECRET } } };
      if (c.path === "/v1/api-keys/key_1/rotate") return { body: { data: { id: "key_1", secret: SECRET } } };
      return undefined;
    }, { session: OWNER });
    const cached = () => JSON.stringify([...qc.getMutationCache().getAll().map((m) => m.state), ...qc.getQueryCache().getAll().map((q) => q.state.data)]);

    await userEvent.click(await screen.findByRole("button", { name: /new key/i }));
    await userEvent.type(screen.getByRole("textbox", { name: /name/i }), "CI");
    await userEvent.click(screen.getByRole("button", { name: /create key/i }));
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /stored it somewhere safe/i }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByText(SECRET)).not.toBeInTheDocument());
    await waitFor(() => expect(cached()).not.toContain(SECRET));

    await userEvent.click(screen.getByRole("button", { name: "Actions for Billing sync" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /rotate/i }));
    await userEvent.click(screen.getByRole("button", { name: /^rotate$/i }));
    expect(await screen.findByText(SECRET)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: /stored it somewhere safe/i }));
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(cached()).not.toContain(SECRET));
  });
});
