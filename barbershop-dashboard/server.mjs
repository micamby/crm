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
  // When started automatically at login, the key is read from a private copy outside the Desktop folder.
  if (process.env.HLCRM_OPS_KEY_FILE) return readFileSync(process.env.HLCRM_OPS_KEY_FILE, "utf8").trim();
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
a{color:var(--accent)}.top{display:flex;gap:16px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card)}.top b{margin-right:auto}.top a{color:var(--fg);text-decoration:none;padding:6px 10px;border-radius:8px}.top a.on{background:var(--line)}</style></head><body><nav class="top"><b>MICROSPACE</b><a href="/" class="on">Numbers</a><a href="/calendar">Calendar</a><a href="/texts">Texts</a><a href="${esc(CRM)}" target="_blank" rel="noopener">Open the app</a></nav><main>
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


// ---- Calendar: one day, one column per barber ----
const SERVICE = { haircut: "Haircut", skin_fade: "Skin fade", cut_and_beard: "Cut and beard", beard_trim: "Beard trim", lineup: "Line-up", kids_cut: "Kids cut" };
const OPEN_HOUR = 8, CLOSE_HOUR = 20, SLOT_MIN = 45, PX_PER_MIN = 1.3;

function tzOffsetMs(instant) {
  const local = new Date(instant.toLocaleString("en-US", { timeZone: TZ }));
  const utc = new Date(instant.toLocaleString("en-US", { timeZone: "UTC" }));
  return local.getTime() - utc.getTime();
}
function dayBounds(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  const start = new Date(guess.getTime() - tzOffsetMs(guess));
  return { start, end: new Date(start.getTime() + DAY) };
}
function todayYmd() {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}
function shiftYmd(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
function minutesIntoDay(iso) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(iso));
  const h = Number(parts.find((p) => p.type === "hour").value), mi = Number(parts.find((p) => p.type === "minute").value);
  return h * 60 + mi;
}

async function calendarPage(ymd, notice = "") {
  const { start, end } = dayBounds(ymd);
  const [appts, barbers, clients] = await Promise.all([
    queryAll("appointment", { and: [{ field: "starts_at", op: "gte", value: start.toISOString() }, { field: "starts_at", op: "lt", value: end.toISOString() }] }),
    queryAll("barber"),
    queryAll("contact"),
  ]);
  const [services, own] = await Promise.all([queryAll("service"), queryAll("barber_service_time")]);
  const ownTimes = {};
  for (const t of own) (ownTimes[t.barber] ??= {})[t.service] = Number(t.length_minutes);
  const svcName = new Map(services.map((x) => [x.id, x.name]));
  const active = services.filter((x) => x.active !== false).sort((a, b) => a.name.localeCompare(b.name));
  clients.sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`));
  const cols = barbers.filter((b) => b.active !== false).sort((a, b) => String(a.home_chair ?? "").localeCompare(String(b.home_chair ?? "")) || a.name.localeCompare(b.name));
  const height = (CLOSE_HOUR - OPEN_HOUR) * 60 * PX_PER_MIN;
  const label = new Date(start.getTime() + 12 * 3600000).toLocaleDateString("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const hours = Array.from({ length: CLOSE_HOUR - OPEN_HOUR + 1 }, (_, i) => OPEN_HOUR + i);
  const hourLabel = (h) => `${((h + 11) % 12) + 1} ${h < 12 ? "AM" : "PM"}`;
  const block = (a) => {
    const top = Math.max(0, (minutesIntoDay(a.starts_at) - OPEN_HOUR * 60) * PX_PER_MIN);
    const time = new Date(a.starts_at).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
    const who = String(a.summary ?? "Appointment").split(" - ")[0];
    const len = Number(a.length_minutes) || SLOT_MIN;
    const end = new Date(new Date(a.starts_at).getTime() + len * 60000).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
    const here = a.status === "booked" && a.checked_in_at
      ? new Date(a.checked_in_at).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }) : "";
    return `<a class="appt s-${esc(a.status)}${here ? " here" : ""}" title="${esc(time)} - ${esc(end)}. Drag to move, or click for options." style="top:${top}px;height:${Math.max(18, len * PX_PER_MIN - 3)}px" href="${esc(CRM)}/o/appointment/${esc(a.id)}" target="_blank" rel="noopener"
      draggable="${a.status === "booked" ? "true" : "false"}" data-id="${esc(a.id)}" data-barber="${esc(a.barber ?? "")}" data-time="${esc(new Date(a.starts_at).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }))}" data-who="${esc(who)}" data-status="${esc(a.status)}" data-here="${a.checked_in_at ? "1" : ""}" data-notes="${esc(a.visit_notes ?? "")}">
      <b>${here ? "✓ " : ""}${esc(time)} ${esc(who)}</b><span>${here ? `Here since ${esc(here)} · ` : ""}${esc(svcName.get(a.service_type) ?? SERVICE[a.service] ?? "")} · ${len} min${a.status !== "booked" ? " · " + esc({ completed: "Done", no_show: "No-show", cancelled: "Cancelled" }[a.status] ?? a.status) : ""}${a.booked_via === "square" ? " · Square" : ""}</span></a>`;
  };
  const unassigned = appts.filter((a) => !cols.some((b) => b.id === a.barber));
  return shell("Calendar", `
<div class="calhead">
  <h1>${esc(label)}</h1>
  <form class="nav" method="get" action="/calendar">
    <a class="btn" href="/calendar?date=${shiftYmd(ymd, -1)}">&larr; Previous day</a>
    <a class="btn" href="/calendar?date=${todayYmd()}">Today</a>
    <a class="btn" href="/calendar?date=${shiftYmd(ymd, 1)}">Next day &rarr;</a>
    <label>Pick a day <input type="date" name="date" value="${esc(ymd)}" onchange="this.form.submit()"></label>
  </form>
</div>
${notice ? `<p class="notice">${esc(notice)}</p>` : ""}
<p class="sub">${appts.length} appointment${appts.length === 1 ? "" : "s"}. <b>Click an empty time</b> to book. <b>Drag</b> a booked appointment to move it, or <b>click</b> it to move it to another day or open it in the app.</p>
<div class="cal" style="--cols:${cols.length}">
  <div class="times" style="height:${height}px">${hours.map((h) => `<span style="top:${(h - OPEN_HOUR) * 60 * PX_PER_MIN}px">${hourLabel(h)}</span>`).join("")}</div>
  ${cols.map((b) => `<div class="col"><div class="colhead">${esc(b.name)}</div><div class="lane" data-barber="${esc(b.id)}" data-name="${esc(b.name)}" data-chair="${esc(b.home_chair ?? "")}" style="height:${height}px">
    ${hours.map((h) => `<i style="top:${(h - OPEN_HOUR) * 60 * PX_PER_MIN}px"></i>`).join("")}
    ${appts.filter((a) => a.barber === b.id).map(block).join("")}</div></div>`).join("")}
</div>
${unassigned.length ? `<p class="sub">${unassigned.length} appointment(s) have no barber set.</p>` : ""}
<dialog id="book"><form method="post" action="/book">
  <h2>Book an appointment</h2>
  <p id="bookwhen" class="sub"></p>
  <input type="hidden" name="date" value="${esc(ymd)}">
  <label>Barber <select name="barber" id="f-barber" required>${cols.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("")}</select></label>
  <label>Time <select name="time" id="f-time" required>${timeOptions()}</select></label>
  <label>Client
    <select name="client" id="f-client">
      <option value="">Choose a client...</option>
      ${clients.map((c) => `<option value="${esc(c.id)}">${esc(c.first_name)} ${esc(c.last_name)}${c.phone ? " · " + esc(c.phone) : ""}</option>`).join("")}
      <option value="new">+ New client</option>
    </select></label>
  <div id="newclient" hidden>
    <label>First name <input name="first_name"></label>
    <label>Last name <input name="last_name"></label>
    <label>Mobile phone <input name="phone" type="tel" placeholder="e.g. 312 555 0123"></label>
  </div>
  <label>Service <select name="service" required>${active.map((x) => `<option value="${esc(x.id)}" data-name="${esc(x.name)}" data-len="${esc(x.length_minutes)}">${esc(x.name)} (${esc(x.length_minutes)} min)</option>`).join("")}</select></label>
  ${active.length ? "" : `<p class="notice">No services yet: add them under <a href="${esc(CRM)}/o/service" target="_blank" rel="noopener">Services</a> in the app.</p>`}
  <label class="inline"><input type="checkbox" name="anyway" value="1"> Book even if it overlaps another appointment</label>

  <label>Booked <select name="booked_via"><option value="in_shop">In the shop</option><option value="square">Square online</option></select></label>
  <div class="actions"><button type="button" class="btn" onclick="document.getElementById('book').close()">Cancel</button><button class="btn primary">Book it</button></div>
</form></dialog>
<dialog id="move"><form method="post" action="/move">
  <h2 id="m-title">Appointment</h2>
  <div class="quick" id="m-quick">
    <button type="button" class="btn primary" data-act="checkin" id="q-in">Check in (they're here)</button>
    <button type="button" class="btn" data-act="undo_checkin" id="q-undo">Undo check-in</button>
    <label>What we chatted about <textarea id="q-notes" rows="2" placeholder="e.g. New job at the hospital"></textarea></label>
    <button type="button" class="btn primary" data-act="done">Finished</button>
    <button type="button" class="btn" data-act="no_show">No-show</button>
    <button type="button" class="btn" data-act="cancelled">Cancelled</button>
  </div>
  <h3 class="movehead">Move it</h3>
  <input type="hidden" name="id" id="m-id"><input type="hidden" name="from" value="${esc(ymd)}">
  <label>Day <input type="date" name="date" id="m-date" value="${esc(ymd)}" required></label>
  <label>Time <select name="time" id="m-time" required>${timeOptions()}</select></label>
  <label>Barber <select name="barber" id="m-barber" required>${cols.map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join("")}</select></label>
  <label class="inline"><input type="checkbox" name="anyway" value="1"> Move even if it overlaps another appointment</label>
  <p><a id="m-open" href="#" target="_blank" rel="noopener">Open in the app</a> (to mark it done, a no-show or cancelled)</p>
  <div class="actions"><button type="button" class="btn" onclick="document.getElementById('move').close()">Close</button><button class="btn primary" id="m-save">Move it</button></div>
</form></dialog>
<script>
const PX=${PX_PER_MIN}, OPEN=${OPEN_HOUR}, OWN=${JSON.stringify(ownTimes).replace(/</g, "\\u003c")};
const bsel=document.getElementById("f-barber");
function lengths(){const o=OWN[bsel.value]||{};document.querySelectorAll('select[name=service] option').forEach(op=>{const n=o[op.value]||op.dataset.len;op.textContent=op.dataset.name+" ("+n+" min)";});}
bsel.addEventListener("change",lengths);
const dlg=document.getElementById("book"), sel=document.getElementById("f-client"), nc=document.getElementById("newclient");
sel.addEventListener("change",()=>{nc.hidden=sel.value!=="new";nc.querySelectorAll("input").forEach(i=>i.required=sel.value==="new"&&i.name!=="phone");});
dlg.querySelector("form").addEventListener("submit",(e)=>{if(!sel.value){e.preventDefault();alert("Choose a client, or pick + New client.");}});
const mv=document.getElementById("move");
document.querySelectorAll(".appt").forEach(a=>{
  a.addEventListener("click",(e)=>{e.preventDefault();
    document.getElementById("m-id").value=a.dataset.id; document.getElementById("m-title").textContent=a.dataset.who;
    document.getElementById("m-time").value=a.dataset.time; document.getElementById("m-barber").value=a.dataset.barber;
    document.getElementById("m-open").href=a.href; const booked=a.dataset.status==="booked";
    document.getElementById("m-save").hidden=!booked; mv.querySelectorAll("form > label, .movehead").forEach(l=>l.hidden=!booked);
    document.getElementById("m-quick").hidden=!booked; document.getElementById("q-in").hidden=a.dataset.here==="1"; document.getElementById("q-undo").hidden=a.dataset.here!=="1";
    document.getElementById("q-notes").value=a.dataset.notes||""; mv.showModal();});
  a.addEventListener("dragstart",(e)=>{e.dataTransfer.setData("text/plain",a.dataset.id);a._grab=e.clientY-a.getBoundingClientRect().top;window._drag=a;});
});
document.querySelectorAll("#m-quick button").forEach(b=>b.addEventListener("click",async()=>{
  const body=new URLSearchParams({id:document.getElementById("m-id").value,act:b.dataset.act,notes:document.getElementById("q-notes").value});
  const r=await fetch("/status",{method:"POST",headers:{"X-Calendar":"status"},body}); const j=await r.json();
  if(j.ok)location.reload(); else alert(j.error);
}));
async function moveTo(id,barber,time,anyway){
  const body=new URLSearchParams({id,barber,time,date:"${esc(ymd)}",from:"${esc(ymd)}",...(anyway?{anyway:"1"}:{})});
  const r=await fetch("/move",{method:"POST",headers:{"X-Calendar":"drag"},body}); const j=await r.json();
  if(j.ok)return location.reload();
  if(j.clash&&confirm(j.error+" Move it there anyway?"))return moveTo(id,barber,time,true);
  if(!j.clash)alert(j.error);
}
document.querySelectorAll(".lane").forEach(l=>{
  l.addEventListener("dragover",(e)=>e.preventDefault());
  l.addEventListener("drop",(e)=>{e.preventDefault();const a=window._drag;if(!a)return;
    const y=e.clientY-l.getBoundingClientRect().top-(a._grab||0), m=Math.min(${CLOSE_HOUR * 60 - 15},Math.max(OPEN*60,Math.round((OPEN*60+y/PX)/15)*15));
    moveTo(a.dataset.id,l.dataset.barber,String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0"),false);});
});
document.querySelectorAll(".lane").forEach(l=>l.addEventListener("click",(e)=>{
  if(e.target.closest(".appt"))return;
  const y=e.clientY-l.getBoundingClientRect().top, m=Math.min(${CLOSE_HOUR * 60 - 15},Math.max(OPEN*60,Math.floor((OPEN*60+y/PX)/15)*15));
  const hh=String(Math.floor(m/60)).padStart(2,"0"), mm=String(m%60).padStart(2,"0");
  document.getElementById("f-time").value=hh+":"+mm; document.getElementById("f-barber").value=l.dataset.barber;
  document.getElementById("bookwhen").textContent="${esc(label)}";
  sel.value=""; nc.hidden=true; lengths(); dlg.showModal();
}));
</script>`);
}

function timeOptions() {
  return Array.from({ length: (CLOSE_HOUR - OPEN_HOUR) * 4 }, (_, i) => OPEN_HOUR * 60 + i * 15).map((m) => {
    const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, "0");
    return `<option value="${String(h).padStart(2, "0")}:${mm}">${((h + 11) % 12) + 1}:${mm} ${h < 12 ? "AM" : "PM"}</option>`;
  }).join("");
}

class Clash extends Error {}
async function findClash(barber, when, len, excludeId) {
  const finish = new Date(when.getTime() + len * 60000);
  const near = await queryAll("appointment", { and: [{ field: "barber", op: "eq", value: barber.id }, { field: "status", op: "in", value: ["booked", "completed"] },
    { field: "starts_at", op: "gte", value: new Date(when.getTime() - 8 * 3600000).toISOString() }, { field: "starts_at", op: "lt", value: finish.toISOString() }] });
  const clash = near.find((a) => a.id !== excludeId && new Date(a.starts_at).getTime() + (Number(a.length_minutes) || SLOT_MIN) * 60000 > when.getTime());
  if (!clash) return;
  const t = new Date(clash.starts_at).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  throw new Clash(`${barber.name} already has ${String(clash.summary ?? "an appointment")} at ${t}.`);
}

async function move(f) {
  if (!/^appt_\w+$/.test(f.id ?? "")) throw new Error("Pick an appointment");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date ?? "") || !/^\d{2}:\d{2}$/.test(f.time ?? "")) throw new Error("Pick a day and a time");
  const appt = (await queryAll("appointment", { field: "id", op: "eq", value: f.id }))[0];
  if (!appt) throw new Error("That appointment wasn't found");
  if (appt.status !== "booked") throw new Error("Only booked appointments can be moved");
  const barber = (await queryAll("barber", { field: "id", op: "eq", value: /^barb_\w+$/.test(f.barber ?? "") ? f.barber : appt.barber }))[0];
  if (!barber) throw new Error("That barber wasn't found");
  const { start } = dayBounds(f.date);
  const [h, m] = f.time.split(":").map(Number);
  const when = new Date(start.getTime() + (h * 60 + m) * 60000);
  if (f.anyway !== "1") await findClash(barber, when, Number(appt.length_minutes) || SLOT_MIN, appt.id);
  await crmWrite("PATCH", `/v1/objects/appointment/records/${appt.id}`, {
    starts_at: when.toISOString(), barber: barber.id, ...(barber.home_chair ? { chair: barber.home_chair } : {}),
  });
  const client = (await queryAll("contact", { field: "id", op: "eq", value: appt.client }))[0];
  if (client && client.next_booked_at === appt.starts_at) await crmWrite("PATCH", `/v1/objects/contact/records/${client.id}`, { next_booked_at: when.toISOString() });
  return when.toLocaleString("en-US", { timeZone: TZ, weekday: "long", hour: "numeric", minute: "2-digit" });
}

async function setStatus(f) {
  if (!/^appt_\w+$/.test(f.id ?? "")) throw new Error("Pick an appointment");
  const appt = (await queryAll("appointment", { field: "id", op: "eq", value: f.id }))[0];
  if (!appt) throw new Error("That appointment wasn't found");
  if (appt.status !== "booked") throw new Error("This appointment is already marked as " + appt.status.replace("_", "-"));
  const notes = String(f.notes ?? "").trim().slice(0, 5000);
  const changes = {
    checkin: { checked_in_at: new Date().toISOString() },
    undo_checkin: { checked_in_at: null },
    done: { status: "completed", ...(notes ? { visit_notes: notes } : {}) },
    no_show: { status: "no_show" },
    cancelled: { status: "cancelled" },
  }[f.act];
  if (!changes) throw new Error("Unknown action");
  // Notes first, so the "visit completed" automation copies them to the client.
  if (changes.visit_notes) { await crmWrite("PATCH", `/v1/objects/appointment/records/${appt.id}`, { visit_notes: changes.visit_notes }); delete changes.visit_notes; }
  await crmWrite("PATCH", `/v1/objects/appointment/records/${appt.id}`, changes);
}

// Reads a form post (small bodies only).
function readForm(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 20000) { reject(new Error("Too much data")); req.destroy(); } });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(body))));
  });
}

async function crmWrite(method, path, body) {
  const res = await fetch(`${CRM}${path}`, { method, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.detail ?? `CRM said ${res.status}`);
  return out.data;
}

async function newClient(f, barber) {
  const first = String(f.first_name ?? "").trim(), last = String(f.last_name ?? "").trim();
  if (!first) throw new Error("Type the new client's first name");
  const owner = barber.member_email ? (await (await fetch(`${CRM}/v1/users`, { headers: { Authorization: `Bearer ${KEY}` } })).json()).data?.find((u) => u.email === barber.member_email)?.id : undefined;
  const phone = String(f.phone ?? "").replace(/[^\d+]/g, "");
  const made = await crmWrite("POST", "/v1/objects/contact/records", {
    first_name: first, ...(last ? { last_name: last } : {}), ...(phone ? { phone: phone.startsWith("+") ? phone : phone.length === 10 ? "+1" + phone : phone } : {}),
    ...(owner ? { owner } : {}), return_every: "w4",
  });
  return made.id;
}

async function book(f) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date ?? "") || !/^\d{2}:\d{2}$/.test(f.time ?? "")) throw new Error("Pick a day and a time");
  if (!/^barb_\w+$/.test(f.barber ?? "")) throw new Error("Pick a barber's column");
  if (!/^serv_\w+$/.test(f.service ?? "")) throw new Error("Pick a service");
  const service = (await queryAll("service", { field: "id", op: "eq", value: f.service }))[0];
  if (!service) throw new Error("That service wasn't found");
  const barber = (await queryAll("barber", { field: "id", op: "eq", value: f.barber }))[0];
  if (!barber) throw new Error("That barber wasn't found");
  const own = (await queryAll("barber_service_time", { and: [{ field: "barber", op: "eq", value: barber.id }, { field: "service", op: "eq", value: service.id }] }))[0];
  const len = Number(own?.length_minutes) || Number(service.length_minutes) || SLOT_MIN;
  const client0 = f.client;
  if (client0 !== "new" && !/^con_\w+$/.test(client0 ?? "")) throw new Error("Choose a client");
  let client = client0;
  const { start } = dayBounds(f.date);
  const [h, m] = f.time.split(":").map(Number);
  const when = new Date(start.getTime() + (h * 60 + m) * 60000);
  if (f.anyway !== "1") {
    try { await findClash(barber, when, len); } catch (e) { throw new Error(`${e.message} Pick another time, or tick "Book even if it overlaps".`); }
  }
  if (client === "new") client = await newClient(f, barber);
  await crmWrite("POST", "/v1/objects/appointment/records", {
    client, barber: barber.id, starts_at: when.toISOString(), service_type: service.id, length_minutes: len,
    ...(barber.home_chair ? { chair: barber.home_chair } : {}), booked_via: f.booked_via === "square" ? "square" : "in_shop",
  });
  return when.toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
}


// ---- Texts to send: one tap opens the phone's Messages with a friendly, ready-made text ----
const firstWord = (n) => String(n ?? "").replace(/\s*\(sample\)\s*/i, "").split(/\s+/)[0] || "your barber";
function fill(tpl, vars) { return String(tpl ?? "").replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k] ?? "") : m)).replace(/\s+$/, ""); }
function smsHref(phone, body) {
  const num = String(phone ?? "").replace(/[^\d+]/g, "");
  return num ? `sms:${num}?&body=${encodeURIComponent(body)}` : null;
}

async function textsPage() {
  const since = new Date(Date.now() - 14 * DAY).toISOString();
  const [tpls, overdue, missed, barbers, usersRes, ws] = await Promise.all([
    queryAll("message_template"),
    queryAll("contact", { field: "overdue", op: "eq", value: true }),
    queryAll("appointment", { and: [{ field: "status", op: "eq", value: "no_show" }, { field: "starts_at", op: "gte", value: since }, { field: "followup_sent_at", op: "is_null", value: true }] }),
    queryAll("barber"),
    fetch(`${CRM}/v1/users`, { headers: { Authorization: `Bearer ${KEY}` } }).then((r) => r.json()),
    fetch(`${CRM}/v1/workspace`, { headers: { Authorization: `Bearer ${KEY}` } }).then((r) => r.json()).catch(() => ({})),
  ]);
  const tpl = Object.fromEntries(tpls.map((t) => [t.name, t.text]));
  const shop = ws?.data?.name ?? "the shop";
  const userName = new Map((usersRes.data ?? []).map((u) => [u.id, u.name]));
  const barberName = new Map(barbers.map((b) => [b.id, b.name]));
  const weekAgo = Date.now() - 7 * DAY;
  const noShowClients = new Set(missed.map((a) => a.client));
  const due = overdue.filter((c) => !noShowClients.has(c.id) && (!c.reminder_sent_at || new Date(c.reminder_sent_at).getTime() < weekAgo));
  const clientIds = [...new Set(missed.map((a) => a.client))];
  const missedClients = new Map((clientIds.length ? await queryAll("contact", { field: "id", op: "in", value: clientIds }) : []).map((c) => [c.id, c]));
  const row = (kind, id, c, barber, body) => {
    const href = smsHref(c.phone, body);
    return `<div class="trow"><div class="twho"><b>${esc(c.first_name)} ${esc(c.last_name ?? "")}</b><span>${esc(firstWord(barber))}'s client${c.phone ? " · " + esc(c.phone) : ""}</span></div>
      <p class="tbody">${esc(body)}</p>
      <div class="tact">${href ? `<a class="btn primary" href="${esc(href)}" data-kind="${kind}" data-id="${esc(id)}">Text ${esc(c.first_name)}</a>` : `<span class="sub">No phone number on file</span>`}
      <button class="btn" type="button" data-copy="${esc(body)}">Copy text</button>
      <button class="btn" type="button" data-kind="${kind}" data-id="${esc(id)}" data-skip="1">Done, hide</button></div></div>`;
  };
  const policy = tpl["Cancellation policy"] ?? "";
  const dueRows = due.map((c) => { const b = userName.get(c.owner); return row("reminder", c.id, c, b, fill(tpl["Time for a cut"], { first_name: c.first_name, barber: firstWord(b), shop, policy })); });
  const missedRows = missed.map((a) => { const c = missedClients.get(a.client); if (!c) return "";
    const b = barberName.get(a.barber); const time = new Date(a.starts_at).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
    const sameDay = new Date(a.starts_at).toLocaleDateString("en-CA", { timeZone: TZ }) === todayYmd();
    const when = sameDay ? `today at ${time}` : `on ${new Date(a.starts_at).toLocaleDateString("en-US", { timeZone: TZ, weekday: "long" })} at ${time}`;
    return row("noshow", a.id, c, b, fill(tpl["Missed appointment"], { first_name: c.first_name, barber: firstWord(b), shop, time, when, policy })); });
  return shell("Texts", `<h1>Texts to send</h1>
<p class="sub">Press <b>Text</b> and your Messages app opens with the text ready. Read it, change anything you like, and press send. Change the wording any time under <a href="${esc(CRM)}/o/message_template" target="_blank" rel="noopener">Messages</a> in the app.</p>
<h2>Missed appointments (${missedRows.filter(Boolean).length})</h2>${missedRows.filter(Boolean).join("") || "<p>No one to follow up right now.</p>"}
<h2>Time for a cut (${dueRows.length})</h2>${dueRows.join("") || "<p>No one is overdue right now.</p>"}
<script>
async function mark(kind,id){await fetch("/texted",{method:"POST",headers:{"X-Calendar":"texted"},body:new URLSearchParams({kind,id})});}
document.querySelectorAll("a[data-kind]").forEach(a=>a.addEventListener("click",()=>{mark(a.dataset.kind,a.dataset.id);a.textContent="Opened Messages";a.closest(".trow").classList.add("sent");}));
document.querySelectorAll("button[data-skip]").forEach(b=>b.addEventListener("click",async()=>{await mark(b.dataset.kind,b.dataset.id);b.closest(".trow").remove();}));
document.querySelectorAll("button[data-copy]").forEach(b=>b.addEventListener("click",async()=>{try{await navigator.clipboard.writeText(b.dataset.copy);b.textContent="Copied";}catch(e){b.textContent="Couldn't copy";}}));
</script>`);
}

async function markTexted(f) {
  const at = new Date().toISOString();
  if (f.kind === "reminder" && /^con_\w+$/.test(f.id ?? "")) return crmWrite("PATCH", `/v1/objects/contact/records/${f.id}`, { reminder_sent_at: at });
  if (f.kind === "noshow" && /^appt_\w+$/.test(f.id ?? "")) return crmWrite("PATCH", `/v1/objects/appointment/records/${f.id}`, { followup_sent_at: at });
  throw new Error("Unknown text");
}

function shell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MICROSPACE ${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#f6f5f2;--fg:#1d1d1b;--muted:#6b6a66;--card:#fff;--line:#e4e2dc;--accent:#1f6f5c;--done:#e7e5df;--miss:#f6dcd6;--book:#d9ece6}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#eeede9;--muted:#a3a29c;--card:#22221f;--line:#34332f;--accent:#5fc4a8;--done:#2c2c29;--miss:#4a2a25;--book:#1f3a33}}
body{margin:0;font:16px/1.45 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:1200px;margin:0 auto;padding:16px 16px 48px}h1{margin:0;font-size:24px}
.top{display:flex;gap:16px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card)}.top b{margin-right:auto}
.top a{color:var(--fg);text-decoration:none;padding:6px 10px;border-radius:8px}.top a.on{background:var(--book)}
.sub{color:var(--muted)}a{color:var(--accent)}
.calhead{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin:8px 0}
.nav{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.btn{border:1px solid var(--line);background:var(--card);border-radius:8px;padding:6px 10px;color:var(--fg);text-decoration:none}
.nav input{font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg)}
.cal{display:grid;grid-template-columns:60px repeat(var(--cols),minmax(150px,1fr));overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding-bottom:8px}
.times{position:relative;margin-top:41px}.times span{position:absolute;right:8px;transform:translateY(-50%);font-size:12px;color:var(--muted)}
.col{border-left:1px solid var(--line)}.colhead{position:sticky;top:0;padding:10px;font-weight:600;border-bottom:1px solid var(--line);height:20px;background:var(--card)}
.lane{position:relative}.lane i{position:absolute;left:0;right:0;border-top:1px solid var(--line)}
.appt{position:absolute;left:4px;right:4px;border-radius:8px;padding:4px 8px;font-size:13px;line-height:1.3;overflow:hidden;color:var(--fg);text-decoration:none;background:var(--book);border-left:4px solid var(--accent)}
.appt span{display:block;color:var(--muted)}.appt.s-completed{background:var(--done);border-left-color:var(--muted)}.appt.s-no_show,.appt.s-cancelled{background:var(--miss);border-left-color:#c0533f}
.trow{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:10px 0}.trow.sent{opacity:.6}.twho span{display:block;color:var(--muted);font-size:14px}
.tbody{margin:8px 0;padding:10px;border-radius:8px;background:var(--bg)}.tact{display:flex;flex-wrap:wrap;gap:8px}.btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
h2{font-size:18px;margin:24px 0 8px}.appt:hover{outline:2px solid var(--accent)}.appt[draggable=true]{cursor:grab}.appt.here{background:#f7e7b4;border-left-color:#b8860b;color:#1d1d1b}.appt.here span{color:#5b4a14}
.quick{display:grid;gap:8px;margin:12px 0}.quick textarea{display:block;width:100%;box-sizing:border-box;font:inherit;padding:8px;margin-top:4px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}.movehead{margin:16px 0 0;font-size:16px}.lane{cursor:copy}
.notice{background:var(--book);border-radius:8px;padding:10px 14px}
dialog{border:1px solid var(--line);border-radius:14px;background:var(--card);color:var(--fg);padding:20px;width:min(420px,92vw)}dialog::backdrop{background:#0006}
dialog h2{margin:0 0 4px}dialog label{display:block;margin:10px 0}dialog input,dialog select{display:block;width:100%;box-sizing:border-box;font:inherit;padding:8px;margin-top:4px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
dialog label.inline{display:flex;gap:8px;align-items:center}dialog label.inline input{display:inline;width:auto;margin:0}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}.btn.primary{background:var(--accent);color:#fff;border-color:var(--accent);font:inherit;cursor:pointer}button.btn{font:inherit;cursor:pointer}
</style></head><body><nav class="top"><b>MICROSPACE</b><a href="/" class="${title === "Numbers" ? "on" : ""}">Numbers</a><a href="/calendar" class="${title === "Calendar" ? "on" : ""}">Calendar</a><a href="/texts" class="${title === "Texts" ? "on" : ""}">Texts</a><a href="${esc(CRM)}" target="_blank" rel="noopener">Open the app</a></nav><main>${body}</main></body></html>`;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "POST" && url.pathname === "/book") {
    const origin = req.headers.origin ?? "";
    if (origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`) { res.writeHead(403).end("Booking only works from this computer's calendar page."); return; }
    let f = {};
    try {
      f = await readForm(req);
      const time = await book(f);
      res.writeHead(303, { Location: `/calendar?date=${encodeURIComponent(f.date)}&booked=${encodeURIComponent(time)}` }).end();
    } catch (e) {
      const day = /^\d{4}-\d{2}-\d{2}$/.test(f.date ?? "") ? f.date : todayYmd();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(await calendarPage(day, `Not booked: ${e.message}`));
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/texted") {
    const origin = req.headers.origin ?? "";
    if ((origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`) || req.headers["x-calendar"] !== "texted") { res.writeHead(403).end("Only from this computer."); return; }
    try { await markTexted(await readForm(req)); res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}'); }
    catch (e) { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }
  if (req.method === "POST" && url.pathname === "/status") {
    const origin = req.headers.origin ?? "";
    if ((origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`) || req.headers["x-calendar"] !== "status") { res.writeHead(403).end("Only from this computer's calendar page."); return; }
    try { await setStatus(await readForm(req)); res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true })); }
    catch (e) { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }
  if (req.method === "POST" && url.pathname === "/move") {
    const origin = req.headers.origin ?? "";
    const drag = req.headers["x-calendar"] === "drag";
    if (origin !== `http://localhost:${PORT}` && origin !== `http://127.0.0.1:${PORT}`) { res.writeHead(403).end("Moving only works from this computer's calendar page."); return; }
    let f = {};
    try {
      f = await readForm(req);
      const when = await move(f);
      if (drag) res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, when }));
      else res.writeHead(303, { Location: `/calendar?date=${encodeURIComponent(f.date)}&moved=${encodeURIComponent(when)}` }).end();
    } catch (e) {
      if (drag) { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, clash: e instanceof Clash, error: e.message })); return; }
      const day = /^\d{4}-\d{2}-\d{2}$/.test(f.from ?? "") ? f.from : todayYmd();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(await calendarPage(day, `Not moved: ${e.message}${e instanceof Clash ? ' Pick another time, or tick "Move even if it overlaps".' : ""}`));
    }
    return;
  }
  if (url.pathname === "/texts") {
    try { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(await textsPage()); }
    catch (e) { res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" }).end(`Couldn't read the CRM. Is Docker running? (${e.message})`); }
    return;
  }
  if (!["/", "/index.html", "/calendar"].includes(url.pathname)) { res.writeHead(404).end("Not found"); return; }
  try {
    const date = url.searchParams.get("date");
    const html = url.pathname === "/calendar"
      ? await calendarPage(/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? date : todayYmd(), url.searchParams.get("booked") ? `Booked for ${url.searchParams.get("booked")}.` : url.searchParams.get("moved") ? `Moved to ${url.searchParams.get("moved")}.` : "")
      : page(await numbers());
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(html);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" }).end(`Couldn't read the CRM. Is Docker running? (${e.message})`);
  }
}).listen(PORT, "127.0.0.1", () => console.log(`MICROSPACE numbers: http://localhost:${PORT}`));
