import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReauthDialog } from "@/features/shell/Reauth";
import { ApiClient } from "@/lib/api/client";
import { ApiProvider } from "@/lib/api/context";
import type { SessionInfo } from "@/lib/api/types";
import { qk } from "@/lib/keys";
import { confirmMethods, signInLinkCommand } from "@/lib/signin";
import { CAPABILITIES, fakeFetch, renderRoute, SESSION, type Call } from "./utils";

/**
 * The first owner's path on a fresh self-hosted install: signed in by a server-printed link, no
 * password, no email, no single sign-on. The app offers a password at once, keeps offering it, and
 * when it must confirm it's them, offers only what can work: here, a new link, with the command.
 */

const NO_PASSWORD: SessionInfo = { ...SESSION, member: { ...SESSION.member, has_password: false } };
const BY_LINK: SessionInfo = { ...NO_PASSWORD, session: { ...NO_PASSWORD.session, id: `ses_${Math.random().toString(36).slice(2)}`, method: "server_link" } };
const BY_CODE: SessionInfo = { ...NO_PASSWORD, session: { ...NO_PASSWORD.session, method: "email_code" } };
// Built in parts so no scanner mistakes it for a real credential.
const NEW_PASSWORD = ["harbour", "lantern", "meadow", "quartz"].join("-");

const answer = (extra: (c: Call) => ReturnType<Parameters<typeof renderRoute>[1]>) => (c: Call) => {
  const r = extra(c);
  if (r) return r;
  if (c.path === "/v1/auth/password" && c.method === "POST") return { body: { data: { has_password: true, other_sessions_revoked: 0 } } };
  return undefined;
};

describe("the welcome step after the first sign-in by link", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("offers to set a password straight away, and can be skipped to the page asked for", async () => {
    renderRoute("/", answer(() => undefined), { session: BY_LINK });
    expect(await screen.findByRole("heading", { level: 1, name: "Welcome, Mia" })).toBeInTheDocument();
    expect(screen.getByText(/can't be used again/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    expect(await screen.findByRole("heading", { level: 1, name: /^Good (morning|afternoon|evening), Mia$/ })).toBeInTheDocument();
    // Skipped for this session: Home still nudges, with its own form.
    expect(await screen.findByRole("region", { name: "Set a password so you can sign in again" })).toBeInTheDocument();
  });

  it("sets the password with no current one, then goes on", async () => {
    let session = BY_LINK;
    const { calls } = renderRoute("/settings/api-keys", answer((c) => {
      if (c.path === "/v1/auth/session") return { body: session };
      if (c.path === "/v1/auth/password") {
        session = { ...session, member: { ...session.member, has_password: true } };
        return { body: { data: { has_password: true, other_sessions_revoked: 0 } } };
      }
      return undefined;
    }), { session: BY_LINK });
    await screen.findByRole("heading", { level: 1, name: "Welcome, Mia" });
    await userEvent.type(screen.getByLabelText("New password"), NEW_PASSWORD);
    await userEvent.type(screen.getByLabelText("New password again"), NEW_PASSWORD);
    await userEvent.click(screen.getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Welcome, Mia" })).not.toBeInTheDocument());
    expect(calls.find((c) => c.path === "/v1/auth/password")!.body).toEqual({ password: NEW_PASSWORD });
  });

  it("isn't shown with a password, where passwords aren't allowed, or after another way of signing in", async () => {
    for (const [session, caps] of [
      [{ ...BY_LINK, member: { ...BY_LINK.member, has_password: true } }, CAPABILITIES],
      [BY_LINK, { ...CAPABILITIES, methods: { ...CAPABILITIES.methods, password: false } }],
      [{ ...BY_LINK, workspace: { ...BY_LINK.workspace, sign_in: { ...BY_LINK.workspace.sign_in, password: false } } }, CAPABILITIES],
      [BY_CODE, CAPABILITIES],
    ] as const) {
      const view = renderRoute("/", (c) => (c.path === "/auth/capabilities" ? { body: caps } : undefined), { session: session as SessionInfo });
      expect(await screen.findByRole("heading", { level: 1, name: /^Good/ })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Welcome, Mia" })).not.toBeInTheDocument();
      view.unmount();
    }
  });
});

describe("the reminders to set a password", () => {
  it("Home shows a dismissible card; dismissing it is remembered in the member's preferences", async () => {
    // The server answers a PUT with all the member's preferences.
    const { calls } = renderRoute("/", (c) => (c.method === "PUT" && c.path === "/v1/me/preferences" ? { body: { data: c.body } } : undefined), { session: BY_CODE });
    const card = await screen.findByRole("region", { name: "Set a password so you can sign in again" });
    expect(within(card).getByLabelText("New password")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: /dismiss/i }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Set a password so you can sign in again" })).not.toBeInTheDocument());
    expect(calls.find((c) => c.method === "PUT" && c.path === "/v1/me/preferences")!.body).toEqual({ "hint.set_password.dismissed": true });
  });

  it("stays dismissed, and never shows to a member with a password", async () => {
    const a = renderRoute("/", (c) => (c.path === "/v1/me/preferences" ? { body: { data: { "hint.set_password.dismissed": true } } } : undefined), { session: BY_CODE });
    await screen.findByRole("heading", { level: 1, name: /^Good/ });
    expect(screen.queryByRole("region", { name: /set a password/i })).not.toBeInTheDocument();
    a.unmount();
    renderRoute("/", () => undefined, { session: SESSION });
    await screen.findByRole("heading", { level: 1, name: /^Good/ });
    expect(screen.queryByRole("region", { name: /set a password/i })).not.toBeInTheDocument();
  });

  it("Settings → Account keeps a hint, and asks for no current password the member doesn't have", async () => {
    renderRoute("/settings/account", (c) => (c.path === "/v1/auth/sessions" || c.path === "/v1/auth/apps" ? { body: { data: [] } } : undefined), { session: BY_CODE });
    const section = await screen.findByRole("region", { name: "Password" });
    expect(within(section).getByRole("note")).toHaveTextContent("Set a password so you can sign in again");
    expect(within(section).queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(within(section).queryByRole("button", { name: "Remove password" })).not.toBeInTheDocument();
  });
});

describe("confirming it's you, with only what can work", () => {
  const OLD = new Date(Date.now() - 20 * 60_000).toISOString();
  const STALE: SessionInfo = { ...BY_LINK, session: { ...BY_LINK.session, id: "ses_old", signed_in_at: OLD } };

  beforeEach(() => {
    vi.stubGlobal("location", { ...window.location, origin: "http://localhost", pathname: "/settings/api-keys", search: "", hash: "", assign: vi.fn(), replace: vi.fn() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function dialog(handler: (c: Call) => { status?: number; body?: unknown } | undefined, session = STALE) {
    const { fetch, calls } = fakeFetch(handler);
    const api = new ApiClient({ fetch, sleep: async () => {} });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(qk.session, session);
    const done = vi.fn();
    render(<ApiProvider value={api}><QueryClientProvider client={qc}><ReauthDialog open onDone={done} /></QueryClientProvider></ApiProvider>);
    return { calls, api, done };
  }

  it("decides from the server's methods, the workspace and the member", () => {
    expect(confirmMethods(CAPABILITIES, NO_PASSWORD)).toEqual({ password: false, emailCode: false, sso: false });
    expect(confirmMethods(CAPABILITIES, SESSION)).toEqual({ password: true, emailCode: false, sso: false });
    expect(confirmMethods({ ...CAPABILITIES, methods: { email_code: true, password: true, sso: { name: "Okta", start: "/auth/sso" } } }, NO_PASSWORD))
      .toEqual({ password: false, emailCode: true, sso: true });
    const noSso = { ...NO_PASSWORD, workspace: { ...NO_PASSWORD.workspace, sign_in: { ...NO_PASSWORD.workspace.sign_in, sso: false } } };
    expect(confirmMethods({ ...CAPABILITIES, methods: { email_code: false, password: true, sso: { name: "Okta", start: "/auth/sso" } } }, noSso).sso).toBe(false);
  });

  it("builds the sign-in-link command the README uses, coming back to the page", () => {
    expect(signInLinkCommand(SESSION, "/settings/api-keys")).toBe("docker compose run --rm api sign-in-link --email me@example.com --workspace ws_1 --return-to /settings/api-keys");
    expect(signInLinkCommand(SESSION, "/o/deal?view=v_1&sort=-amount")).toBe("docker compose run --rm api sign-in-link --email me@example.com --workspace ws_1 --return-to '/o/deal?view=v_1&sort=-amount'");
    expect(signInLinkCommand({ ...SESSION, member: { ...SESSION.member, email: "o'neil@example.com" } }, "/")).toBe("docker compose run --rm api sign-in-link --email 'o'\\''neil@example.com' --workspace ws_1");
  });

  it("with no password, no email and no single sign-on: no password box, the command to run, and the action carries on once the new link is opened", async () => {
    const fresh: SessionInfo = { ...BY_LINK, session: { ...BY_LINK.session, id: "ses_new", signed_in_at: new Date().toISOString() }, csrf_token: "fresh-token" };
    let live = STALE;
    const { api, done } = dialog((c) => (c.path === "/auth/capabilities" ? { body: CAPABILITIES } : c.path === "/v1/auth/session" ? { body: live } : undefined));
    const d = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(await within(d).findByTestId("sign-in-link-command")).toHaveTextContent(
      "docker compose run --rm api sign-in-link --email me@example.com --workspace ws_1 --return-to /settings/api-keys");
    expect(within(d).queryByLabelText("Password")).not.toBeInTheDocument();
    expect(within(d).queryByText(/sign in another way/i)).not.toBeInTheDocument();
    expect(d).toHaveTextContent(/ask them for a new sign-in link/);
    // Not yet: the session is still the old one.
    await userEvent.click(within(d).getByRole("button", { name: "I've opened the link" }));
    expect(await within(d).findByRole("status")).toHaveTextContent("Not yet");
    expect(done).not.toHaveBeenCalled();
    // The link was opened in another tab: this browser's session is now a new, recent one.
    live = fresh;
    await act(async () => {
      await userEvent.click(within(d).getByRole("button", { name: "I've opened the link" }));
    });
    await waitFor(() => expect(done).toHaveBeenCalledWith(true));
    expect(api.hasCsrfToken()).toBe(true);
  });

  it("with email but no password: no password box, and a way to sign in again", async () => {
    dialog((c) => (c.path === "/auth/capabilities" ? { body: { ...CAPABILITIES, methods: { ...CAPABILITIES.methods, email_code: true } } } : undefined));
    const d = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(await within(d).findByText(/an emailed code/)).toBeInTheDocument();
    expect(within(d).queryByLabelText("Password")).not.toBeInTheDocument();
    expect(within(d).getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  });

  it("the sign-in page in its confirming mode says the same, instead of a password form that can't work", async () => {
    renderRoute("/sign-in?reauth=1&return_to=%2Fsettings%2Fapi-keys", () => undefined, { session: STALE });
    expect(await screen.findByRole("heading", { name: "Confirm it's you" })).toBeInTheDocument();
    expect(await screen.findByTestId("sign-in-link-command")).toHaveTextContent("--return-to /settings/api-keys");
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
    expect(screen.queryByText(/Ask an admin/)).not.toBeInTheDocument();
  });
});
