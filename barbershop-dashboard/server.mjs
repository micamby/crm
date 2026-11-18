// MICROSPACE numbers page: a small read-only page that reads the CRM and shows the shop's numbers.
// Runs on this computer only (http://localhost:8790). No extra packages needed: node server.mjs
// The CRM's "ops" key is read from ~/Desktop/CRM-SECRET-KEYS.txt (or the HLCRM_OPS_KEY environment variable).
import http from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CRM = process.env.HLCRM_URL ?? "http://localhost:8787";
const PORT = Number(process.env.PORT ?? 8790);
const REBOOK_WINDOW_NOTE = "booked before leaving or within 3 days after";
const TZ = process.env.SHOP_TIMEZONE ?? "America/Chicago";

function opsKey() {
  if (process.env.HLCRM_OPS_KEY) return process.env.HLCRM_OPS_KEY;
  const text = readFileSync(join(homedir(), "Desktop", "CRM-SECRET-KEYS.txt"), "utf8");
  const m = text.match(/Ops key[^:]*:\s*(hlcrm_\w+)/);
  if (!m) throw new Error("No ops key found in CRM-SECRET-KEYS.txt");
  return m[1];
}
const KEY = opsKey();

async function queryAll(object, where) {
  const out = [];
  let cursor;
  do {
    const res = await fetch(`${CRM}/v1/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ object, ...(where ? { where } : {}), limit: 200, ...(cursor ? { cursor } : {}) }),
    });
    if (!res.ok) throw new Error(`CRM said ${res.status} for ${object}`);
    const body = await res.json();
    out.push(...body.data);
    cursor = body.next_cursor;
  } while (cursor && out.length < 20000);
  return out;
}

const DAY = 86400000;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pct = (a, b) => (b ? Math.round((100 * a) / b) : null);
const localDay = (iso) => new Date(iso).toLocaleDateString("en-US", { weekday: "long", timeZone: TZ });

function startOfWeek(now) {
  // Monday 00:00 in the shop's time zone, close enough for a weekly count.
  const local = new Date(now.toLocaleString("en-US", { timeZone: TZ }));
  const offset = now.getTime() - local.getTime();
  const day = (local.getDay() + 6) % 7;
  local.setHours(0, 0, 0, 0);
  return new Date(local.getTime() - day * DAY + offset);
}

async function numbers() {
  const [appts, clients, barbers] = await Promise.all([queryAll("appointment"), queryAll("contact"), queryAll("barber")]);
  const now = new Date();
  const since30 = new Date(now.getTime() - 30 * DAY);
  const since56 = new Date(now.getTime() - 56 * DAY);
  const week = startOfWeek(now);
  const monthStart = new Date(new Date(now.toLocaleString("en-US", { timeZone: TZ })).setDate(1));
  const name = new Map(barbers.map((b) => [b.id, b.name]));

  const per = new Map(barbers.filter((b) => b.active !== false).map((b) => [b.id, { name: b.name, done30: 0, rebooked30: 0, week: 0, noshow30: 0 }]));
  const days = new Map(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((d) => [d, 0]));
  for (const a of appts) {
    const t = new Date(a.starts_at);
    const row = per.get(a.barber) ?? (a.barber ? per.set(a.barber, { name: name.get(a.barber) ?? "Unknown", done30: 0, rebooked30: 0, week: 0, noshow30: 0 }).get(a.barber) : null);
    if (!row || t > now) continue;
    if (a.status === "completed") {
      if (t >= since30) { row.done30++; if (a.rebooked) row.rebooked30++; }
      if (t >= week) row.week++;
      if (t >= since56) days.set(localDay(a.starts_at), (days.get(localDay(a.starts_at)) ?? 0) + 1);
    }
    if (a.status === "no_show" && t >= since30) row.noshow30++;
  }
  const rows = [...per.values()].sort((a, b) => (pct(b.rebooked30, b.done30) ?? -1) - (pct(a.rebooked30, a.done30) ?? -1));
  const shop = rows.reduce((s, r) => ({ done30: s.done30 + r.done30, rebooked30: s.rebooked30 + r.rebooked30, week: s.week + r.week, noshow30: s.noshow30 + r.noshow30 }), { done30: 0, rebooked30: 0, week: 0, noshow30: 0 });
  const newClients = clients.filter((c) => new Date(c.created_at) >= monthStart).length;
  const overdue = clients.filter((c) => c.overdue).sort((a, b) => String(a.next_visit_due).localeCompare(String(b.next_visit_due)));
  const quiet = clients.filter((c) => c.last_visit_at && new Date(c.last_visit_at) < new Date(now.getTime() - 60 * DAY)).length;
  return { rows, shop, newClients, overdue, quiet, days, barberName: name, updated: now };
}

function page(n) {
  const busiest = Math.max(1, ...n.days.values());
  const card = (label, value, note = "") => `<div class="card"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div>${note ? `<div class="n">${esc(note)}</div>` : ""}</div>`;
  const shopRate = pct(n.shop.rebooked30, n.shop.done30);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MICROSPACE numbers</title><style>
:root{color-scheme:light dark;--bg:#f6f5f2;--fg:#1d1d1b;--muted:#6b6a66;--card:#fff;--line:#e4e2dc;--accent:#1f6f5c}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#eeede9;--muted:#a3a29c;--card:#22221f;--line:#34332f;--accent:#5fc4a8}}
body{margin:0;font:16px/1.45 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:960px;margin:0 auto;padding:24px 16px 48px}h1{margin:0;font-size:26px}h2{font-size:18px;margin:32px 0 10px}
.sub{color:var(--muted);margin:4px 0 20px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.v{font-size:30px;font-weight:650}.l{color:var(--muted)}.n{color:var(--muted);font-size:13px;margin-top:4px}
.tbl{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:12px}table{border-collapse:collapse;width:100%;min-width:520px}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:500;font-size:14px}tr:last-child td{border-bottom:0}
.bar{height:10px;background:var(--accent);border-radius:5px}.day{display:grid;grid-template-columns:110px 1fr 40px;gap:10px;align-items:center;margin:6px 0}
a{color:var(--accent)}</style></head><body><main>
<h1>MICROSPACE numbers</h1><p class="sub">Updated ${esc(n.updated.toLocaleString("en-US", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }))}. Refresh the page for the latest.</p>
<div class="cards">
${card("Shop rebook rate (30 days)", shopRate === null ? "-" : shopRate + "%", REBOOK_WINDOW_NOTE)}
${card("Cuts this week", n.shop.week)}
${card("New clients this month", n.newClients)}
${card("Overdue, nothing booked", n.overdue.length, "on the call-back list")}
${card("Not seen in 60+ days", n.quiet)}
${card("No-shows (30 days)", n.shop.noshow30)}
</div>
<h2>By barber</h2><div class="tbl"><table><thead><tr><th>Barber</th><th>Rebook rate (30 days)</th><th>Rebooked</th><th>Cuts (30 days)</th><th>Cuts this week</th><th>No-shows</th></tr></thead><tbody>
${n.rows.map((r) => `<tr><td>${esc(r.name)}</td><td><b>${pct(r.rebooked30, r.done30) ?? "-"}${r.done30 ? "%" : ""}</b></td><td>${r.rebooked30} of ${r.done30}</td><td>${r.done30}</td><td>${r.week}</td><td>${r.noshow30}</td></tr>`).join("")}
</tbody></table></div>
<h2>Busiest days (last 8 weeks)</h2>
${[...n.days].map(([d, c]) => `<div class="day"><span>${d}</span><div class="bar" style="width:${Math.round((100 * c) / busiest)}%"></div><span>${c}</span></div>`).join("")}
<h2>Call-back list</h2>${n.overdue.length === 0 ? "<p>No one is overdue right now.</p>" : `<div class="tbl"><table><thead><tr><th>Client</th><th>Barber's due date</th><th>Phone</th></tr></thead><tbody>
${n.overdue.slice(0, 50).map((c) => `<tr><td><a href="${esc(CRM)}/o/contact/${esc(c.id)}">${esc(c.first_name)} ${esc(c.last_name)}</a></td><td>${esc(c.next_visit_due ?? "")}</td><td>${esc(c.phone ?? "")}</td></tr>`).join("")}
</tbody></table></div>`}
</main></body></html>`;
}

http.createServer(async (req, res) => {
  if (req.url !== "/" && req.url !== "/index.html") { res.writeHead(404).end("Not found"); return; }
  try {
    const html = page(await numbers());
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(html);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" }).end(`Couldn't read the CRM. Is Docker running? (${e.message})`);
  }
}).listen(PORT, "127.0.0.1", () => console.log(`MICROSPACE numbers: http://localhost:${PORT}`));
