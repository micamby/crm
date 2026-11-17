import { readFileSync } from "node:fs";
import { HlCrmError } from "@hl-crm-db/sdk";
import type { Command } from "commander";
import { limits, type ObjectAccess } from "../access.js";
import { configPath, KEY_PATTERN, keyHint, readConfig, REMOTE_NAME, writeConfig } from "../config.js";
import { makeClient, type Context } from "../context.js";
import { CliError, EXIT, toCliError, usage } from "../errors.js";
import { clean } from "../output.js";
import type { Act } from "../program.js";
import { CLI_VERSION } from "../version.js";

interface Me { workspace: { id: string; name: string; schema_version: number }; actor: { type: string; id: string | null; role: string };
  permissions: string[]; scopes: string[]; server_version?: string }

/** Reads the key from stdin (--with-token) or a no-echo prompt. Never from an argument: argv shows up in shell history and `ps`. */
async function readKey(ctx: Context, withToken: boolean): Promise<string> {
  let key: string;
  if (withToken) key = (await ctx.rt.readStdin()).trim();
  else if (ctx.g.input && ctx.rt.interactive) key = (await ctx.rt.promptSecret("API key (input hidden): ")).trim();
  else throw usage("No terminal to prompt on: pipe the key to crm auth login --with-token");
  if (!KEY_PATTERN.test(key)) throw usage("That is not an hl-crm-db API key (hlcrm_live_… or hlcrm_test_…)");
  return key;
}

export function registerAuth(program: Command, act: Act): void {
  const auth = program.command("auth").description("Log in, check and log out of an hl-crm-db API");

  auth.command("login")
    .description("Save a connection: verifies the API key with GET /v1/me, then stores it in the config file (0600)")
    .requiredOption("--url <api>", "the API's base URL, e.g. https://crm.example.com")
    .option("--name <remote>", "name for this connection", "default")
    .option("--with-token", "read the API key from stdin instead of prompting")
    .addHelpText("after", "\nThe key is never taken as an argument. Examples:\n  crm auth login --url https://crm.example.com\n  echo \"$HLCRM_KEY\" | crm auth login --url https://crm.example.com --with-token --name prod")
    .action(act(async (ctx, opts: { url: string; name: string; withToken?: boolean }) => {
      if (!REMOTE_NAME.test(opts.name)) throw usage("--name must be lowercase letters, digits, - and _ (up to 40)");
      const url = opts.url.replace(/\/+$/, "");
      makeClient(ctx.rt, url, "", Boolean(ctx.g.insecureHttp)); // checks the URL (https, no credentials) before asking for the key
      const key = await readKey(ctx, Boolean(opts.withToken));
      const me = await makeClient(ctx.rt, url, key, Boolean(ctx.g.insecureHttp)).get<Me>("/v1/me");
      const config = readConfig(ctx.configDir);
      config.remotes[opts.name] = { url, key, ...(ctx.g.insecureHttp ? { insecure_http: true } : {}), workspace: me.workspace.name };
      config.current = opts.name;
      writeConfig(ctx.configDir, config);
      const result = { remote: opts.name, url, workspace: me.workspace, actor: me.actor, key: keyHint(key), config: configPath(ctx.configDir) };
      if (ctx.g.json) return ctx.out.data(result);
      ctx.out.line(`Logged in to ${clean(me.workspace.name)} as ${me.actor.id ?? me.actor.type} (${me.actor.role}) with key ${keyHint(key)}.`);
      ctx.out.line(`Saved as remote "${opts.name}" in ${configPath(ctx.configDir)}.`);
    }));

  auth.command("status")
    .description("Show which API and identity commands will use, and check the key still works")
    .action(act(async (ctx) => {
      const conn = ctx.connection();
      const me = await ctx.client(conn).get<Me>("/v1/me");
      const result = { remote: conn.name, url: conn.url, source: conn.source, key: keyHint(conn.key), workspace: me.workspace, actor: me.actor,
        permissions: me.permissions, scopes: me.scopes };
      if (ctx.g.json) return ctx.out.data(result);
      ctx.out.line(`Remote:      ${conn.name ?? "(environment)"}${conn.source.url === "env" || conn.source.key === "env" ? "  [HLCRM_API_URL/HLCRM_API_KEY]" : ""}`);
      ctx.out.line(`API:         ${conn.url}`);
      ctx.out.line(`Workspace:   ${clean(me.workspace.name)} (${me.workspace.id})`);
      ctx.out.line(`Identity:    ${me.actor.id ?? me.actor.type}, role ${me.actor.role}`);
      ctx.out.line(`Key:         ${keyHint(conn.key)}, scopes ${me.scopes.join(", ")}`);
      ctx.out.line(`Permissions: ${me.permissions.join(", ") || "(none)"}`);
    }));

  auth.command("logout")
    .description("Forget the saved key of a remote (the current one, or --remote). The key itself stays valid until revoked")
    .action(act(async (ctx) => {
      const config = readConfig(ctx.configDir);
      const name = ctx.g.remote ?? config.current;
      const remote = name && Object.hasOwn(config.remotes, name) ? config.remotes[name] : undefined;
      if (!name || !remote) throw new CliError("not_logged_in", "No saved remote to log out of", EXIT.usage);
      const hint = keyHint(remote.key);
      delete remote.key;
      writeConfig(ctx.configDir, config);
      if (ctx.g.json) return ctx.out.data({ remote: name, logged_out: true, key: hint });
      ctx.out.line(`Removed the key for "${name}" from ${configPath(ctx.configDir)}.`);
      ctx.out.line(`The key (${hint}) still works until it is revoked: crm keys list, then crm keys revoke <id>.`);
    }));

  const remote = program.command("remote").description("Saved connections");
  remote.command("list").description("List saved remotes").action(act(async (ctx) => {
    const config = readConfig(ctx.configDir);
    const rows = Object.entries(config.remotes).map(([name, r]) => ({ current: name === config.current ? "*" : "", name, url: r.url,
      workspace: r.workspace ?? "", key: r.key ? keyHint(r.key) : "(logged out)", insecure_http: r.insecure_http ?? false }));
    if (ctx.g.json) return ctx.out.data({ current: config.current ?? null, remotes: rows.map(({ current: _c, ...r }) => r) });
    ctx.out.table(rows, ["current", "name", "url", "workspace", "key"]);
  }));
  remote.command("use <name>").description("Make a saved remote the current one").action(act(async (ctx, name: string) => {
    const config = readConfig(ctx.configDir);
    if (!Object.hasOwn(config.remotes, name)) throw new CliError("unknown_remote", `No saved remote named "${name}"`, EXIT.usage);
    config.current = name;
    writeConfig(ctx.configDir, config);
    if (ctx.g.json) return ctx.out.data({ current: name });
    ctx.out.line(`Now using "${name}" (${config.remotes[name]!.url}).`);
  }));
  remote.command("remove <name>").description("Delete a saved remote and its key from the config file").action(act(async (ctx, name: string) => {
    const config = readConfig(ctx.configDir);
    if (!Object.hasOwn(config.remotes, name)) throw new CliError("unknown_remote", `No saved remote named "${name}"`, EXIT.usage);
    delete config.remotes[name];
    if (config.current === name) config.current = undefined;
    writeConfig(ctx.configDir, config);
    if (ctx.g.json) return ctx.out.data({ removed: name });
    ctx.out.line(`Removed "${name}".`);
  }));

  program.command("doctor")
    .description("Check the config file, connectivity, the key, clock skew, the server version and what the key may do, record access included")
    .action(act(async (ctx) => doctor(ctx)));

  program.command("api <method> <path>")
    .description("Send an authenticated request for anything the CLI has no command for, and print the response")
    .option("-d, --data <json|@file|->", "request body: JSON text, @file to read a file, or - to read stdin")
    .option("--if-match <version>", "send If-Match with this version")
    .addHelpText("after", "\nExamples:\n  crm api GET /v1/schema\n  crm api GET '/v1/objects/contact/records?filter[email]=a@b.com'\n  crm api POST /v1/objects/contact/records --data '{\"email\":\"a@b.com\"}'\n  crm api PATCH /v1/objects/contact/fields/email --data @patch.json")
    .action(act(async (ctx, method: string, path: string, opts: { data?: string; ifMatch?: string }) => {
      const m = method.toUpperCase();
      if (!["GET", "POST", "PATCH", "DELETE"].includes(m)) throw usage("method must be GET, POST, PATCH or DELETE");
      const [p, qs] = path.split(/\?(.*)/s);
      const query = Object.fromEntries(new URLSearchParams(qs ?? ""));
      let body: unknown;
      if (opts.data !== undefined) {
        const text = opts.data === "-" ? await ctx.rt.readStdin() : opts.data.startsWith("@") ? readFileSync(opts.data.slice(1), "utf8") : opts.data;
        try {
          body = JSON.parse(text);
        } catch {
          throw usage("--data must be JSON");
        }
      }
      const ifMatch = opts.ifMatch === undefined ? undefined : Number(opts.ifMatch.replace(/\D/g, ""));
      const res = await ctx.client().requestText(m as "GET", p!, { body, query, ifMatch });
      let parsed: unknown;
      try {
        parsed = res.text ? JSON.parse(res.text) : null;
      } catch {
        ctx.out.raw(res.text);
        return;
      }
      ctx.out.data(parsed);
    }));
}

type Check = { check: string; status: "ok" | "warn" | "fail"; detail: string };

async function doctor(ctx: Context): Promise<void> {
  const checks: Check[] = [];
  const add = (check: string, status: Check["status"], detail: string) => checks.push({ check, status, detail });
  let me: Me | undefined;
  let access: ObjectAccess[] | undefined;
  try {
    readConfig(ctx.configDir);
    add("config file", "ok", `${configPath(ctx.configDir)} (owner-only, or not created yet)`);
  } catch (e) {
    add("config file", "fail", toCliError(e).message);
  }
  let conn;
  try {
    conn = ctx.connection();
    add("remote", "ok", `${conn.name ?? "(environment)"} → ${conn.url} (URL from ${conn.source.url}, key ${keyHint(conn.key)} from ${conn.source.key})`);
  } catch (e) {
    add("remote", "fail", toCliError(e).message);
  }
  if (conn) {
    if (conn.url.startsWith("http://")) add("transport", "warn", "plain http: the API key is sent unencrypted");
    const client = ctx.client(conn);
    try {
      const t0 = Date.now();
      const res = await client.requestText("GET", "/v1/me", { accept: "application/json" });
      const rtt = Date.now() - t0;
      me = JSON.parse(res.text) as Me;
      add("connectivity", "ok", `reached the API in ${rtt} ms`);
      add("authentication", "ok", `${clean(me.workspace.name)} as ${me.actor.id ?? me.actor.type} (role ${me.actor.role})`);
      const date = res.headers.get("date");
      if (date) {
        const skew = Math.round((Date.parse(date) - (t0 + rtt / 2)) / 1000);
        add("clock", Math.abs(skew) > 60 ? "warn" : "ok", `${skew >= 0 ? "+" : ""}${skew}s against the server${Math.abs(skew) > 60 ? " (webhook signatures and key expiry use time)" : ""}`);
      } else add("clock", "warn", "the server sent no Date header; not checked");
      const sv = me.server_version ?? "unknown";
      const minor = (v: string) => v.split(".").slice(0, 2).join(".");
      add("version", sv !== "unknown" && minor(sv) === minor(CLI_VERSION) ? "ok" : "warn", `server ${sv}, CLI ${CLI_VERSION}`);
      add("permissions", me.permissions.length ? "ok" : "warn", me.permissions.join(", ") || "this key can do nothing");
      try {
        access = (await client.get<{ data: { objects: ObjectAccess[] } }>("/v1/me/access")).data.objects;
        const l = limits(access);
        add("record access", "ok", l.length ? `limited: ${l.slice(0, 8).join("; ")}${l.length > 8 ? `; and ${l.length - 8} more (crm --json doctor)` : ""}`
          : "read, write and archive on every object and field");
      } catch (e) {
        add("record access", "warn", `not reported (${toCliError(e).message})`);
      }
    } catch (e) {
      const err = toCliError(e);
      if (e instanceof HlCrmError) {
        add("connectivity", "ok", "reached the API");
        add("authentication", "fail", `${err.message}${err.extra.requestId ? ` (request ${err.extra.requestId})` : ""}`);
      } else add("connectivity", "fail", err.message);
    }
  }
  const failed = checks.some((c) => c.status === "fail");
  ctx.exitCode = !failed ? EXIT.ok : checks.some((c) => c.check === "authentication" && c.status === "fail") || checks.some((c) => c.check === "remote" && c.status === "fail") ? EXIT.auth : EXIT.failure;
  if (ctx.g.json) return ctx.out.data({ ok: !failed, checks, cli_version: CLI_VERSION, server_version: me?.server_version ?? null, record_access: access ?? null });
  for (const c of checks) {
    const mark = c.status === "ok" ? ctx.out.paint("add", "ok  ") : c.status === "warn" ? ctx.out.paint("warn", "warn") : ctx.out.paint("remove", "FAIL");
    ctx.out.line(`${mark}  ${c.check.padEnd(15)} ${c.detail}`);
  }
}
