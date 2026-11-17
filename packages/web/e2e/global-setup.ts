import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ORIGIN, ROOT, SERVER, serverCli, serverEnv, STATE, type E2EState } from "./env";

/**
 * Prepares a fresh workspace in the E2E database and starts the API serving the built app:
 * migrate, bootstrap (owner + admin key), then sample data, a custom object, and a member with a
 * field-limited custom role, all through the public API.
 */
export default async function setup() {
  if (!existsSync(join(ROOT, "packages", "web", "dist", "index.html"))) throw new Error("Build the app first: pnpm --filter @hl-crm-db/web build");
  serverCli(["migrate"]);
  const stamp = Date.now().toString(36);
  const owner = `owner-${stamp}@example.com`;
  const out = serverCli(["bootstrap", "--name", `E2E Studio ${stamp}`, "--email", owner, "--owner-name", "Olivia Owner"]);
  const adminKey = /Admin key[^:]*:\s*(\S+)/.exec(out)?.[1];
  const workspace = /\((ws_[0-9A-Za-z]+)\)/.exec(out)?.[1];
  if (!adminKey || !workspace) throw new Error("bootstrap printed no admin key or workspace");

  const api = spawn(join(SERVER, "node_modules", ".bin", "tsx"), ["src/cli.ts", "api"], { cwd: SERVER, env: serverEnv(), stdio: "ignore", detached: false });
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(`${ORIGIN}/readyz`).then((r) => r.ok).catch(() => false);
    if (ok) break;
    if (i === 59) throw new Error("the API didn't start");
    await new Promise((r) => setTimeout(r, 500));
  }

  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${ORIGIN}${path}`, { method, headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  };

  // Accounts, contacts (a few hundred, enough to page and scroll), deals in every stage, tasks, a note.
  const industries = ["Software", "Healthcare", "Logistics", "Retail"];
  const accounts: string[] = [];
  for (const [i, name] of ["Acme Robotics", "Bluebird Health", "Cobalt Freight", "Dune Outfitters", "Ember Labs"].entries()) {
    accounts.push((await call("POST", "/v1/objects/account/records", { name, domain: `${name.split(" ")[0]!.toLowerCase()}.example`, industry: industries[i % 4], type: i % 2 ? "prospect" : "customer" })).data.id);
  }
  const first = ["Ada", "Ben", "Cleo", "Dev", "Esme", "Finn", "Gia", "Hugo", "Iris", "Jon", "Kai", "Lena"];
  const last = ["Arden", "Brook", "Castle", "Dale", "Ellis", "Frost", "Gale", "Hale", "Irwin", "Jett"];
  const contacts: string[] = [];
  for (let b = 0; b < 3; b++) {
    const records = Array.from({ length: 100 }, (_, j) => {
      const n = b * 100 + j;
      return { first_name: first[n % first.length], last_name: `${last[(n * 7) % last.length]}${n >= 120 ? ` ${n}` : ""}`, email: `person${n}@${["acme", "bluebird", "cobalt", "dune", "ember"][n % 5]}.example`,
        job_title: ["CEO", "CTO", "Buyer", "Engineer", "Designer"][n % 5], account: accounts[n % accounts.length] };
    });
    contacts.push(...(await call("POST", "/v1/objects/contact/records/batch", { records })).data.map((r: { id: string }) => r.id));
  }
  const deals: string[] = [];
  const stages = ["Qualification", "Discovery", "Proposal", "Negotiation", "Closed won", "Closed lost"];
  for (let i = 0; i < 12; i++) {
    const d = (await call("POST", "/v1/objects/deal/records", { name: `${["Acme", "Bluebird", "Cobalt", "Dune", "Ember"][i % 5]} ${["pilot", "renewal", "expansion"][i % 3]} ${i + 1}`,
      account: accounts[i % 5], primary_contact: contacts[i], amount: 4000 + i * 1750, expected_close_date: new Date(Date.now() + (i + 2) * 6 * 86_400_000).toISOString().slice(0, 10) })).data.id;
    deals.push(d);
    const target = stages[i % stages.length]!;
    if (target !== "Qualification") await call("POST", "/v1/ops/move_deal_stage", { deal: d, stage: target, ...(target === "Closed lost" ? { lost_reason: "Timing" } : {}) });
  }
  const me = (await call("GET", "/v1/me")).actor.id as string;
  for (const [i, title] of ["Send the pilot proposal", "Call Bluebird about renewal", "Review Cobalt contract"].entries()) {
    await call("POST", "/v1/objects/task/records", { title, assignee: me, due_at: new Date(Date.now() + (i - 1) * 86_400_000).toISOString(), priority: i === 0 ? "high" : "normal", related_to: [deals[i]] });
  }
  await call("POST", "/v1/ops/log_activity", { type: "note", subject: "Kick-off call", body: "Agreed on a two-week pilot.", related_to: [deals[0], contacts[0]] });

  // A custom object with a relation, a select, money and a status with its own moves.
  await call("POST", "/v1/objects", { api_name: "project", label: "Project", plural_label: "Projects", id_prefix: "prj", display_field: "title", owned: true, fields: [
    { api_name: "title", type: "text", required: true },
    { api_name: "client", type: "relation", options: { to: "account" } },
    { api_name: "budget", type: "currency" },
    { api_name: "kind", type: "single_select", options: { values: [{ key: "build", label: "Build" }, { key: "audit", label: "Audit" }] } },
    { api_name: "phase", type: "status", options: { values: [{ key: "planned", label: "Planned" }, { key: "active", label: "Active" }, { key: "done", label: "Done" }], initial: "planned", transitions: { planned: ["active"], active: ["done"] } } },
  ] });
  await call("POST", "/v1/objects/project/records", { title: "Warehouse robots", client: accounts[0], budget: 25000, kind: "build" });
  // A custom object with "_" in its API name and a long label (the palette's Create group, a phone-width header).
  await call("POST", "/v1/objects", { api_name: "onboarding_engagement", label: "Customer onboarding engagement", plural_label: "Customer onboarding engagements", id_prefix: "oen",
    display_field: "title", owned: true, fields: [{ api_name: "title", type: "text", required: true }, { api_name: "account", type: "relation", options: { to: "account" } }] });

  // A custom object with one field of each newer type: address, json, rating, percent, duration.
  await call("POST", "/v1/objects", { api_name: "site", label: "Site", plural_label: "Sites", id_prefix: "sit", display_field: "name", owned: true, fields: [
    { api_name: "name", type: "text", required: true },
    { api_name: "hq", label: "Headquarters", type: "address" },
    { api_name: "fit", label: "Fit", type: "rating" },
    { api_name: "discount", label: "Discount", type: "percent" },
    { api_name: "call_length", label: "Call length", type: "duration" },
    { api_name: "settings", label: "Settings", type: "json" },
  ] });
  for (const site of [
    { name: "Austin office", hq: { line1: "500 Congress Ave", city: "Austin", region: "TX", postal_code: "78701", country: "US" }, fit: 4, discount: 12.5, call_length: 5400, settings: { timezone: "America/Chicago", desks: 40 } },
    { name: "Berlin office", hq: { city: "Berlin", country: "DE" }, fit: 2, discount: 30, call_length: "PT30M", settings: { timezone: "Europe/Berlin" } },
    { name: "Paris office", hq: { city: "Paris", postal_code: "75002", country: "FR" }, fit: 5, discount: 5, call_length: 7200 },
  ]) await call("POST", "/v1/objects/site/records", site);

  // A member whose role hides contact emails and makes job titles read-only, and can't see deals at all.
  await call("POST", "/v1/roles", { key: "field_limited", name: "Field limited", permissions: ["records:read", "records:write"],
    objects: { deal: { read: false, write: false } }, fields: { contact: { email: "none", job_title: "read" } } });
  const limited = `limited-${stamp}@example.com`;
  await call("POST", "/v1/members", { email: limited, name: "Lee Limited", role: "field_limited" });

  // Settings fixtures (automations, packs): one automation the settings list shows, paused and resumed by the tests.
  await call("POST", "/v1/automations", { name: "Flag big deals", trigger: { type: "event", event: "deal.created" },
    condition: { field: "amount", op: "gte", value: 50000 }, actions: [{ type: "notify", title: "Big deal: {{record.name}}", recipients: { record_owner: true } }], hourly_cap: 50 });

  const state: E2EState = { workspace, owner, limited, pid: api.pid!, adminKey, ids: { account: accounts[0]!, contact: contacts[0]!, deal: deals[0]! } };
  writeFileSync(STATE, JSON.stringify(state));
  void ROOT;
}
