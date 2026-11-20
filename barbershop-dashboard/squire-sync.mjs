// Squire -> MICROSPACE: reads each barber's private Squire calendar link (standard iCal) and keeps the
// appointments in step: new events become appointments, moved events move, cancelled ones are marked cancelled.
// Read-only towards Squire. Finished, no-show and checked-in appointments are never changed by the sync.

const DAY = 86400000;

/** Unfold and split an iCal document into VEVENTs with their properties. */
export function parseIcs(text) {
  const lines = String(text).replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const [name, ...params] = line.slice(0, i).split(";");
    const p = Object.fromEntries(params.map((x) => x.split("=")).map(([k, v]) => [k.toUpperCase(), v]));
    cur[name.toUpperCase()] = { value: line.slice(i + 1), params: p };
  }
  return events;
}

const unescape = (s) => String(s ?? "").replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();

function offsetMs(instant, tz) {
  const local = new Date(instant.toLocaleString("en-US", { timeZone: tz }));
  const utc = new Date(instant.toLocaleString("en-US", { timeZone: "UTC" }));
  return local.getTime() - utc.getTime();
}

/** iCal date-time (UTC "Z", with TZID, floating, or all-day) -> Date. */
export function icsDate(prop, shopTz) {
  if (!prop) return null;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(prop.value.trim());
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00", z] = m;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (z) return new Date(asUtc);
  const tz = prop.params.TZID ? prop.params.TZID.replace(/^"|"$/g, "") : shopTz;
  try {
    const guess = new Date(asUtc);
    return new Date(asUtc - offsetMs(guess, tz));
  } catch {
    return new Date(asUtc - offsetMs(new Date(asUtc), shopTz));
  }
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Turn one calendar event into what we need. Squire's exact wording isn't documented, so this is forgiving:
 * it looks for a known service name and a known client name anywhere in the title or notes, and otherwise
 * treats the title (minus the service) as the client's name.
 */
export function readEvent(ev, { services, clients, shopTz }) {
  const title = unescape(ev.SUMMARY?.value);
  const notes = unescape(ev.DESCRIPTION?.value);
  const start = icsDate(ev.DTSTART, shopTz);
  const end = icsDate(ev.DTEND, shopTz);
  if (!start) return null;
  const text = norm(`${title} ${notes}`);
  const service = [...services].sort((a, b) => b.name.length - a.name.length).find((s) => text.includes(norm(s.name)));
  const client = clients.find((c) => {
    const full = norm(`${c.first_name ?? ""} ${c.last_name ?? ""}`);
    return full.includes(" ") && text.includes(full);
  });
  let name = title;
  if (service) name = name.replace(new RegExp(service.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "");
  name = name.replace(/\b(with|appointment|booking|at)\b.*$/i, "").replace(/[-–|:·•()]+/g, " ").replace(/\s+/g, " ").trim();
  const minutes = end ? Math.round((end - start) / 60000) : null;
  return {
    uid: unescape(ev.UID?.value) || `${start.toISOString()}|${title}`,
    start, minutes: minutes && minutes > 0 && minutes <= 480 ? minutes : null,
    cancelled: /CANCEL/i.test(ev.STATUS?.value ?? "") || /cancel/i.test(title),
    service, client, clientName: name, title,
  };
}

/** Sync every barber that has a Squire calendar link. Returns a short report. */
export async function syncSquire({ queryAll, crmWrite, shopTz, userIdFor = async () => null, fetchImpl = fetch, log = () => {} }) {
  const barbers = (await queryAll("barber")).filter((b) => b.squire_calendar_link && b.active !== false);
  const report = { barbers: barbers.length, created: 0, moved: 0, cancelled: 0, newClients: 0, errors: [] };
  if (!barbers.length) return report;
  const [services, clients] = await Promise.all([queryAll("service"), queryAll("contact")]);
  for (const b of barbers) {
    try {
      const url = String(b.squire_calendar_link).trim().replace(/^webcal:\/\//i, "https://");
      if (!/^https?:\/\//i.test(url)) throw new Error("the Squire calendar link doesn't look like a web address");
      const res = await fetchImpl(url, { headers: { Accept: "text/calendar" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Squire answered ${res.status}`);
      const body = await res.text();
      if (!/BEGIN:VCALENDAR/.test(body)) throw new Error("the link didn't return a calendar");
      const events = parseIcs(body).map((ev) => readEvent(ev, { services, clients, shopTz })).filter(Boolean);
      const now = Date.now();
      const mine = await queryAll("appointment", { and: [{ field: "barber", op: "eq", value: b.id }, { field: "squire_event_id", op: "is_null", value: false }] });
      const byUid = new Map(mine.map((a) => [a.squire_event_id, a]));
      const seen = new Set();
      for (const e of events) {
        if (e.start.getTime() < now - 30 * DAY) continue; // only recent and upcoming
        seen.add(e.uid);
        const existing = byUid.get(e.uid);
        if (existing) {
          if (existing.status !== "booked" || existing.checked_in_at) continue; // the barber's own changes win
          if (e.cancelled) { await crmWrite("PATCH", `/v1/objects/appointment/records/${existing.id}`, { status: "cancelled" }); report.cancelled++; continue; }
          const changes = {};
          if (new Date(existing.starts_at).getTime() !== e.start.getTime()) changes.starts_at = e.start.toISOString();
          if (e.minutes && Number(existing.length_minutes) !== e.minutes) changes.length_minutes = e.minutes;
          if (Object.keys(changes).length) { await crmWrite("PATCH", `/v1/objects/appointment/records/${existing.id}`, changes); report.moved++; }
          continue;
        }
        if (e.cancelled) continue;
        let clientId = e.client?.id;
        if (!clientId) {
          const [first, ...rest] = (e.clientName || "Squire client").split(" ");
          const owner = await userIdFor(b.member_email);
          const made = await crmWrite("POST", "/v1/objects/contact/records", { first_name: first, ...(rest.length ? { last_name: rest.join(" ") } : {}), return_every: "w4", ...(owner ? { owner } : {}) });
          clientId = made.id;
          clients.push(made);
          report.newClients++;
        }
        await crmWrite("POST", "/v1/objects/appointment/records", {
          client: clientId, barber: b.id, starts_at: e.start.toISOString(), squire_event_id: e.uid, booked_via: "square",
          ...(e.service ? { service_type: e.service.id } : {}),
          ...(e.minutes ? { length_minutes: e.minutes } : e.service ? { length_minutes: Number(e.service.length_minutes) } : {}),
          ...(b.home_chair ? { chair: b.home_chair } : {}),
        });
        report.created++;
      }
      // Upcoming Squire appointments that disappeared from the feed were cancelled in Squire.
      for (const a of mine) {
        if (a.status === "booked" && !a.checked_in_at && !seen.has(a.squire_event_id) && new Date(a.starts_at).getTime() > now) {
          await crmWrite("PATCH", `/v1/objects/appointment/records/${a.id}`, { status: "cancelled" });
          report.cancelled++;
        }
      }
    } catch (e) {
      report.errors.push(`${b.name}: ${e.message}`);
    }
  }
  log(report);
  return report;
}
