import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createServerLink } from "../src/auth/signin.js";
import { bootstrapReport, expectedFailure, shellWord } from "../src/cli-output.js";
import { ApiError, ConfigError } from "../src/lib/errors.js";
import { pluralize } from "../src/lib/plural.js";
import { Browser, call, newWorkspace, signedIn, validate, type Schema, type Workspace } from "./helpers.js";

/**
 * What a newcomer meets first: the server's command line (bootstrap's next steps, one-line errors,
 * a sign-in link that comes back where it was asked to), what the session tells the app about the
 * member (no password yet, so it offers to set one), and default plural labels.
 */

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..");

let ws: Workspace;
beforeAll(async () => {
  ws = await newWorkspace("First run");
});

describe("default plural labels", () => {
  it.each([
    ["Property", "Properties"], ["Company", "Companies"], ["Day", "Days"], ["Survey", "Surveys"],
    ["Box", "Boxes"], ["Church", "Churches"], ["Wish", "Wishes"], ["Waltz", "Waltzes"], ["Quiz", "Quizzes"],
    ["Address", "Addresses"], ["Status", "Statuses"], ["Campus", "Campuses"], ["Analysis", "Analyses"],
    ["Settings", "Settings"], ["News", "News"], ["Projects", "Projects"],
    ["Person", "People"], ["Child", "Children"], ["SKU", "SKUs"], ["Project", "Projects"],
    ["Rental property", "Rental properties"], ["Customer onboarding engagement", "Customer onboarding engagements"], ["Key", "Keys"],
  ])("%s → %s", (label, plural) => {
    expect(pluralize(label)).toBe(plural);
  });

  it("is what an object created without plural_label gets; an explicit plural_label wins", async () => {
    const made = await call("POST", "/v1/objects", { key: ws.keys.admin, body: { api_name: "property", fields: [{ api_name: "title", type: "text" }] } });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const got = await call("GET", "/v1/objects/property", { key: ws.keys.admin });
    expect(got.json.data).toMatchObject({ label: "Property", plural_label: "Properties" });
    await call("POST", "/v1/objects", { key: ws.keys.admin, body: { api_name: "rental_unit", label: "Unit", plural_label: "Units to let", fields: [] } });
    expect((await call("GET", "/v1/objects/rental_unit", { key: ws.keys.admin })).json.data).toMatchObject({ label: "Unit", plural_label: "Units to let" });
  });
});

describe("the session tells the app what the member can do", () => {
  it("says the member has no password until they set one, whether they are linked to SSO, and whether connected apps are on", async () => {
    const b = await signedIn(ws.ownerEmail, ws.id, new Browser());
    const before = await b.request("GET", "/v1/auth/session");
    expect(before.json).toMatchObject({ session: { method: "server_link" }, member: { has_password: false, sso_linked: false }, server: { connected_apps: true } });
    const doc = (await call("GET", "/v1/openapi.json", { key: ws.keys.admin })).json as Schema;
    const paths = doc.paths as Record<string, Record<string, { responses: Record<string, { content: Record<string, { schema: Schema }> }> }>>;
    expect(validate(doc, paths["/v1/auth/session"]!.get!.responses["200"]!.content["application/json"]!.schema, before.json)).toEqual([]);

    // A first password needs no current one while the sign-in is recent.
    const set = await b.request("POST", "/v1/auth/password", { body: { password: ["Correct", "horse", "battery", "staple", String(Date.now())].join(" ") } });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect((await b.request("GET", "/v1/auth/session")).json.member).toMatchObject({ has_password: true });
  });
});

describe("server-printed links", () => {
  it("land where --return-to says, also in a browser that is already signed in, which then holds the new session", async () => {
    const b = await signedIn(ws.ownerEmail, ws.id, new Browser());
    const first = (await b.request("GET", "/v1/auth/session")).json.session.id as string;
    const link = await createServerLink(ws.ownerEmail, ws.id, "t", "/settings/api-keys?tab=new#create");
    const token = new URL(link.url).searchParams.get("token")!;
    // The /auth/link page's Continue button is a form post; it answers with a redirect to return_to.
    const used = await b.request("POST", "/auth/server-link", { form: { token } });
    expect(used.status).toBe(303);
    expect(used.headers.get("location")).toBe("/settings/api-keys?tab=new#create");
    const now = (await b.request("GET", "/v1/auth/session")).json;
    expect(now.session.id).not.toBe(first);
    expect(Date.now() - new Date(now.session.signed_in_at).getTime()).toBeLessThan(60_000);
  });

  it("refuse a --return-to that isn't a path on this server, instead of quietly dropping it", async () => {
    for (const bad of ["https://evil.example/", "//evil.example/x", "settings", "/a/../b", "/\\evil"]) {
      await expect(createServerLink(ws.ownerEmail, ws.id, "t", bad)).rejects.toThrow(ConfigError);
    }
  });
});

describe("the server command line", () => {
  it("bootstrap prints the next command in both forms and says to set a password after signing in", () => {
    const out = bootstrapReport({ workspace: { id: "ws_1", name: "Acme" }, owner: { id: "usr_1", email: "o@example.com" }, keys: { admin: "ADMIN", ops: "OPS" },
      email: "o@example.com", publicUrl: true });
    expect(out).toContain("  docker compose run --rm api sign-in-link --email o@example.com --workspace ws_1\n");
    expect(out).toContain("  hl-crm-db-server sign-in-link --email o@example.com --workspace ws_1\n");
    expect(out).toMatch(/set a password/i);
    expect(out).not.toContain("PUBLIC_URL");
    expect(bootstrapReport({ workspace: { id: "ws_1", name: "Acme" }, owner: { id: "usr_1", email: "o'x@example.com" }, keys: { admin: "A", ops: "O" },
      email: "o'x@example.com", publicUrl: false })).toContain(`--email 'o'\\''x@example.com'`);
    expect(shellWord("/settings/api-keys?x=1&y=2")).toBe("'/settings/api-keys?x=1&y=2'");
  });

  it("tells expected failures (setup, usage, a refused request) apart from crashes", () => {
    expect(expectedFailure(new ConfigError("Set PUBLIC_URL first"))).toBe("Set PUBLIC_URL first");
    expect(expectedFailure(new ApiError(422, "validation_failed", "Enter a valid email address"))).toBe("Enter a valid email address");
    expect(expectedFailure(Object.assign(new TypeError("Unknown option '--emial'"), { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" }))).toMatch(/^Unknown option '--emial'/);
    expect(expectedFailure(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }))).toMatch(/^Can't connect to the database/);
    expect(expectedFailure(new Error("boom"))).toBeNull();
  });

  /** Runs the real `hl-crm-db-server` entry point (as the e2e tests and `pnpm dev` do, through tsx). */
  const server = (args: string[], env: Record<string, string | undefined>) => spawnSync(join(SERVER, "node_modules", ".bin", "tsx"), ["src/cli.ts", ...args], {
    cwd: SERVER, encoding: "utf8", timeout: 60_000, env: { ...process.env, LOG_LEVEL: "info", ...env } as NodeJS.ProcessEnv,
  });

  it("a configuration problem is one plain line on stderr and exit code 1, not a fatal log with a stack trace", () => {
    const r = server(["sign-in-link", "--email", ws.ownerEmail], { PUBLIC_URL: "", MCP_PUBLIC_URL: "" });
    expect(r.status).toBe(1);
    expect(r.stderr.trim().split("\n")).toEqual([expect.stringMatching(/^Set PUBLIC_URL first/)]);
    expect(r.stdout).not.toMatch(/fatal|stack|at .*\.ts:\d+/);
    const bad = server(["sign-in-link", "--email", ws.ownerEmail], { PUBLIC_URL: "ftp://crm.example", MCP_PUBLIC_URL: "" });
    expect(bad.status).toBe(1);
    expect(bad.stderr.trim().split("\n")).toEqual([expect.stringMatching(/^PUBLIC_URL must use https/)]);
    expect(bad.stdout).toBe("");
  }, 120_000);

  it("a usage mistake is one plain line too, for every command", () => {
    for (const args of [["sign-in-link"], ["sign-in-link", "--emial", "x@example.com"], ["bootstrap", "--name", "X"], ["mcp-stdio", "--nope"]]) {
      const r = server(args, {});
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stderr.trim().split("\n"), args.join(" ")).toHaveLength(1);
      expect(r.stdout, args.join(" ")).not.toMatch(/fatal|stack/);
    }
  }, 120_000);
});
