import { withTenant } from "./db/tx.js";
import { createRecord } from "./core/records.js";
import { moveDealStage } from "./core/ops.js";
import { authenticate } from "./core/keys.js";
import { createWorkspace } from "./core/workspace.js";
import type { Ctx } from "./core/context.js";

const COMPANIES = [
  ["Northwind Traders", "northwind.example", "Wholesale"], ["Globex", "globex.example", "Manufacturing"],
  ["Initech", "initech.example", "Software"], ["Umbrella Health", "umbrella-health.example", "Healthcare"],
  ["Stark Logistics", "stark-logistics.example", "Logistics"], ["Wayne Analytics", "wayne-analytics.example", "Software"],
  ["Acme Robotics", "acme-robotics.example", "Manufacturing"], ["Hooli Cloud", "hooli.example", "Software"],
  ["Vandelay Imports", "vandelay.example", "Wholesale"], ["Pied Piper", "piedpiper.example", "Software"],
] as const;
const FIRST = ["Ada", "Grace", "Alan", "Katherine", "Linus", "Margaret", "Tim", "Barbara", "Dennis", "Radia", "Ken", "Frances"];
const LAST = ["Lovelace", "Hopper", "Turing", "Johnson", "Torvalds", "Hamilton", "Berners-Lee", "Liskov", "Ritchie", "Perlman", "Thompson", "Allen"];
const STAGES = ["Qualification", "Discovery", "Proposal", "Negotiation", "Closed won", "Closed lost"];

/** Creates a demo workspace with realistic sample data, through the same service layer as the API. */
export async function seedDemo() {
  const ws = await createWorkspace({ name: "Demo Co", ownerEmail: "owner@demo.example", ownerName: "Demo Owner" });
  const principal = await authenticate(ws.keys.admin);
  if (!principal) throw new Error("seed: could not authenticate the new key");
  const ctx: Ctx = { ...principal, surface: "system", requestId: "seed" };
  let contacts = 0;
  let deals = 0;
  await withTenant(ctx.tenantId, async (tx) => {
    for (const [i, [name, domain, industry]] of COMPANIES.entries()) {
      const account = await createRecord(tx, ctx, "account", { name, domain, industry, employee_count: 20 + i * 37, type: i % 3 === 0 ? "customer" : "prospect" });
      const people = [];
      for (let j = 0; j < 4; j++) {
        const first = FIRST[(i + j) % FIRST.length]!;
        const last = LAST[(i * 2 + j) % LAST.length]!;
        people.push(await createRecord(tx, ctx, "contact", {
          first_name: first, last_name: last, email: `${first}.${last}@${domain}`.toLowerCase().replace(/[^a-z0-9.@-]/g, ""),
          job_title: ["CEO", "Head of Sales", "Operations Lead", "Engineer"][j], account: account.id, source: "seed",
        }));
        contacts++;
      }
      const deal = await createRecord(tx, ctx, "deal", {
        name: `${name} — annual plan`, account: account.id, primary_contact: people[0]!.id, amount: 5000 + i * 2500,
        expected_close_date: new Date(Date.now() + (i + 1) * 7 * 86_400_000).toISOString().slice(0, 10),
      });
      deals++;
      const target = STAGES[i % STAGES.length]!;
      if (target !== "Qualification") await moveDealStage(tx, ctx, { deal: deal.id, stage: target, lost_reason: target === "Closed lost" ? "Budget" : undefined }, false);
      await createRecord(tx, ctx, "activity", { type: "note", subject: "Intro call", body: `Spoke with ${people[0]!.display_name} about their goals.`, related_to: [deal.id, people[0]!.id] });
      await createRecord(tx, ctx, "lead", { contact: people[1]!.id, interest: "Enterprise plan", source: "seed", status: i % 2 ? "working" : "new" });
    }
  });
  return { summary: `${COMPANIES.length} accounts, ${contacts} contacts, ${deals} deals`, keys: ws.keys };
}
