import { z } from "zod";
import { unprocessable } from "../lib/errors.js";
import { nextLocalTime } from "./notifications.js";

/**
 * The schedule language for automations. Deliberately small (no cron strings): one of
 *   every:   { minutes: 15..1440 } or { hours: 1..168 }, ticks aligned to the clock in UTC
 *   daily:   { at: "HH:MM" }
 *   weekly:  { days: ["mon", …], at: "HH:MM" }
 *   monthly: { day: 1..31 | "last", at: "HH:MM" } (a day past the month's end runs on its last day)
 * Times are local to the automation's time zone (an IANA name), else the workspace's.
 * A local time skipped by a daylight-saving change runs at the first moment after it.
 */

export const MIN_INTERVAL_MINUTES = 15;
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM (24-hour)");
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export const ScheduleFields = {
  every: z.object({
    minutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(1440).optional(),
    hours: z.number().int().min(1).max(168).optional(),
  }).strict().optional(),
  daily: z.object({ at: HHMM }).strict().optional(),
  weekly: z.object({ days: z.array(z.enum(DAYS)).min(1).max(7), at: HHMM }).strict().optional(),
  monthly: z.object({ day: z.union([z.number().int().min(1).max(31), z.literal("last")]), at: HHMM }).strict().optional(),
  timezone: z.string().min(1).max(64).optional().describe("IANA time zone, e.g. Europe/Berlin; defaults to the workspace's"),
};
export interface Schedule {
  every?: { minutes?: number; hours?: number }; daily?: { at: string }; weekly?: { days: (typeof DAYS)[number][]; at: string };
  monthly?: { day: number | "last"; at: string }; timezone?: string;
}

export function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Checks a schedule has exactly one rule and a usable time zone. */
export function checkSchedule(s: Schedule): void {
  const kinds = (["every", "daily", "weekly", "monthly"] as const).filter((k) => s[k] !== undefined);
  if (kinds.length !== 1) throw unprocessable("A schedule needs exactly one of every, daily, weekly or monthly");
  if (s.every) {
    const set = [s.every.minutes, s.every.hours].filter((v) => v !== undefined);
    if (set.length !== 1) throw unprocessable(`every needs exactly one of minutes (at least ${MIN_INTERVAL_MINUTES}) or hours`);
  }
  if (s.timezone !== undefined && !validTimezone(s.timezone)) throw unprocessable(`Unknown time zone "${s.timezone}"; use an IANA name such as America/Denver`);
}

const intervalMs = (e: NonNullable<Schedule["every"]>) => (e.minutes ?? (e.hours ?? 1) * 60) * 60_000;

/** The local calendar date in `tz`: weekday 0 (Sunday) to 6, day of month, and the month's length. */
function localDate(at: Date, tz: string): { weekday: number; day: number; monthDays: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(at).map((x) => [x.type, x.value]));
  const year = Number(p.year);
  const month = Number(p.month);
  return { weekday: DAYS.indexOf(String(p.weekday).toLowerCase().slice(0, 3) as (typeof DAYS)[number]), day: Number(p.day),
    monthDays: new Date(Date.UTC(year, month, 0)).getUTCDate() };
}

/** The first tick strictly after `after`. */
export function nextRun(s: Schedule, after: Date, workspaceTz: string): Date {
  const tz = s.timezone ?? workspaceTz;
  if (s.every) {
    const ms = intervalMs(s.every);
    return new Date((Math.floor(after.getTime() / ms) + 1) * ms);
  }
  const spec = (s.daily ?? s.weekly ?? s.monthly)!;
  const [hh, mm] = spec.at.split(":").map(Number) as [number, number];
  let t = nextLocalTime(after, tz, hh, mm);
  // At most 62 daily candidates: enough to reach any weekday, and any day of the next month.
  for (let i = 0; i < 62; i++) {
    const d = localDate(t, tz);
    if (s.daily) return t;
    if (s.weekly && s.weekly.days.includes(DAYS[d.weekday]!)) return t;
    if (s.monthly && d.day === (s.monthly.day === "last" ? d.monthDays : Math.min(s.monthly.day, d.monthDays))) return t;
    t = nextLocalTime(t, tz, hh, mm);
  }
  throw new Error("schedule has no next run"); // unreachable for a checked schedule
}

/** The next `n` ticks after `from`, for previews. */
export function upcoming(s: Schedule, from: Date, workspaceTz: string, n = 5): string[] {
  const out: string[] = [];
  let t = from;
  for (let i = 0; i < n; i++) {
    t = nextRun(s, t, workspaceTz);
    out.push(t.toISOString());
  }
  return out;
}

/** "every 30 minutes", "daily at 09:00 (Europe/Berlin)", … */
export function describeSchedule(s: Schedule, workspaceTz: string): string {
  const tz = ` (${s.timezone ?? workspaceTz})`;
  if (s.every) return s.every.minutes ? `every ${s.every.minutes} minutes` : `every ${s.every.hours} hour${s.every.hours === 1 ? "" : "s"}`;
  if (s.daily) return `daily at ${s.daily.at}${tz}`;
  if (s.weekly) return `every ${s.weekly.days.join(", ")} at ${s.weekly.at}${tz}`;
  const day = s.monthly!.day;
  return `monthly on ${day === "last" ? "the last day" : `day ${day}`} at ${s.monthly!.at}${tz}`;
}
