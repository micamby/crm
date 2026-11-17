import { z } from "zod";
import type { UiOp } from "@/lib/filters";
import type { AddressPart, FieldMeta, FieldType, KnownFieldType, ObjectAccess, ObjectMeta } from "@/lib/api/types";
import { isCountryCode } from "./countries";

/**
 * What each field type supports, decided from describe output alone: which operators filter it, whether
 * it sorts, whether this caller may change it, how a form value becomes an API value, and the client-side
 * checks that mirror the server's (the server still decides). No object is special-cased here.
 *
 * A field type this UI doesn't know (a server newer than the app) is shown read-only as text, filters
 * by "is empty" only, never sorts and has no editor: `isKnownType` guards every place that would.
 */

const KNOWN_TYPES: ReadonlySet<string> = new Set<KnownFieldType>([
  "text", "long_text", "number", "currency", "boolean", "date", "datetime", "single_select", "multi_select",
  "email", "phone", "url", "relation", "status", "address", "json", "rating", "percent", "duration",
]);
export const isKnownType = (t: FieldType): t is KnownFieldType => KNOWN_TYPES.has(t);

/** An address's parts, in describe's order (its `parts`), else the standard six. */
export const ADDRESS_PARTS: AddressPart[] = [
  { name: "line1", label: "Address line 1" }, { name: "line2", label: "Address line 2" }, { name: "city", label: "City" },
  { name: "region", label: "State or region" }, { name: "postal_code", label: "Postal code" }, { name: "country", label: "Country" },
];
export function addressParts(f: Pick<FieldMeta, "parts">): AddressPart[] {
  if (!Array.isArray(f.parts) || !f.parts.length) return ADDRESS_PARTS;
  return f.parts.map((p) => {
    const name = typeof p === "string" ? p : p.name;
    const known = ADDRESS_PARTS.find((x) => x.name === name);
    return { name, label: (typeof p === "object" && p.label) || known?.label || name.replace(/_/g, " ") };
  }).filter((p) => /^[a-z][a-z0-9_]{0,62}$/.test(p.name));
}

/** An address as one line: its `display` when the server sent one, else its parts joined. */
export function addressLine(v: unknown): string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "";
  const a = v as Record<string, unknown>;
  if (typeof a.display === "string" && a.display.trim()) return a.display.replace(/\s*\n\s*/g, ", ");
  return ["line1", "line2", "city", "region", "postal_code", "country"].map((k) => a[k]).filter((x): x is string => typeof x === "string" && x.trim() !== "").join(", ");
}

/** Fields of an object filtered and sorted by their parts (`field.part`): its addresses. */
export const partFields = (o: Pick<ObjectMeta, "fields">): Set<string> => new Set(o.fields.filter((f) => f.type === "address").map((f) => f.name));

/** Sortable parts of an object's address fields, as {name: "field.part", label}. */
export function sortableParts(o: Pick<ObjectMeta, "fields">): { name: string; label: string }[] {
  return o.fields.filter((f) => f.type === "address" && isVisible(f) && !isRestricted(f)).flatMap((f) => addressParts(f).map((p) => ({ name: `${f.name}.${p.name}`, label: `${f.label} → ${p.label ?? p.name}` })));
}

/** Seconds as "1d 2h 3m" (with seconds only when there are any, or under a minute). */
export function formatDuration(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "";
  if (v === 0) return "0m";
  const neg = v < 0;
  let n = Math.round(Math.abs(v));
  const parts: string[] = [];
  for (const [unit, size] of [["d", 86_400], ["h", 3_600], ["m", 60]] as const) {
    if (n >= size) {
      parts.push(`${Math.floor(n / size)}${unit}`);
      n %= size;
    }
  }
  if (n > 0 || !parts.length) parts.push(`${n}s`);
  return `${neg ? "-" : ""}${parts.join(" ")}`;
}

/** "1h 30m", "90m", "2d", "45s", "1.5h" or plain seconds ("5400") to seconds; null when it isn't a duration. */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (t === "") return null;
  if (/^\d+$/.test(t)) return Number(t);
  const re = /(\d+(?:\.\d+)?)\s*(d|days?|h|hrs?|hours?|m|mins?|minutes?|s|secs?|seconds?)\b/g;
  let total = 0;
  let consumed = "";
  for (const m of t.matchAll(re)) {
    const n = Number(m[1]);
    const u = m[2]![0]!;
    total += n * (u === "d" ? 86_400 : u === "h" ? 3_600 : u === "m" ? 60 : 1);
    consumed += m[0];
  }
  if (!consumed || t.replace(re, "").replace(/[\s,]+/g, "") !== "") return null;
  return Math.round(total);
}

export const JSON_MAX_BYTES = 16 * 1024;
/** The longest value each address part takes (the server's ADDRESS_PARTS); country is a two-letter code. */
export const ADDRESS_PART_MAX: Record<string, number> = { line1: 200, line2: 200, city: 100, region: 100, postal_code: 20 };
/** Durations are whole seconds from 0 to this (about 3,000 years), as the server keeps them. */
export const DURATION_MAX = 1e11;
/** Percentages are kept to this many decimal places; the server refuses more rather than rounding. */
export const PERCENT_DECIMALS = 4;
const decimals = (n: number) => {
  const m = /^-?\d+(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(n));
  if (!m) return 0;
  return Math.max(0, (m[1]?.length ?? 0) - Number(m[2] ?? 0));
};

/** Relation targets that are platform entities rather than objects: they have fixed fields and their own pickers. */
export const ENTITY_FIELDS: Record<string, { name: string; label: string; type: FieldType }[]> = {
  user: [{ name: "name", label: "Name", type: "text" }, { name: "email", label: "Email", type: "email" }],
  pipeline: [{ name: "name", label: "Name", type: "text" }],
  stage: [{ name: "name", label: "Name", type: "text" }, { name: "category", label: "Category", type: "text" }],
};
export const isEntity = (name: string | undefined): boolean => name !== undefined && Object.hasOwn(ENTITY_FIELDS, name);

export const RESTRICTED_VALUE = "[restricted]";
export const isRestrictedValue = (v: unknown) => v === RESTRICTED_VALUE;

export const TEXT_MAX: Partial<Record<FieldType, number>> = { text: 2000, long_text: 100_000, email: 320, phone: 50, url: 2048 };

export interface OperatorInfo { op: UiOp; label: string }

const EMPTY: OperatorInfo[] = [{ op: "empty", label: "is empty" }, { op: "not_empty", label: "is not empty" }];
const TEXT_OPS: OperatorInfo[] = [
  { op: "contains", label: "contains" }, { op: "eq", label: "is" }, { op: "neq", label: "is not" }, { op: "starts_with", label: "starts with" }, ...EMPTY,
];
const CHOICE_OPS: OperatorInfo[] = [
  { op: "eq", label: "is" }, { op: "neq", label: "is not" }, { op: "in", label: "is any of" }, { op: "not_in", label: "is none of" }, ...EMPTY,
];
const NUMBER_OPS: OperatorInfo[] = [
  { op: "eq", label: "=" }, { op: "neq", label: "≠" }, { op: "gt", label: ">" }, { op: "gte", label: "≥" }, { op: "lt", label: "<" }, { op: "lte", label: "≤" }, ...EMPTY,
];
const DATE_OPS: OperatorInfo[] = [
  { op: "eq", label: "is on" }, { op: "lt", label: "is before" }, { op: "gt", label: "is after" }, { op: "gte", label: "is on or after" }, { op: "lte", label: "is on or before" }, ...EMPTY,
];
const DATETIME_OPS: OperatorInfo[] = [
  { op: "lt", label: "is before" }, { op: "gt", label: "is after" }, ...EMPTY,
];

/** The operators the API accepts for a field type (core/query.ts), in the order the builder offers them. */
export function operatorsFor(type: FieldType): OperatorInfo[] {
  switch (type) {
    case "text": case "long_text": case "email": case "phone": case "url": return TEXT_OPS;
    case "single_select": case "status": case "relation": return CHOICE_OPS;
    case "multi_select": return [{ op: "contains", label: "includes" }, ...EMPTY];
    case "number": case "currency": case "rating": case "percent": case "duration": return NUMBER_OPS;
    case "date": return DATE_OPS;
    case "datetime": return DATETIME_OPS;
    case "boolean": return [{ op: "eq", label: "is" }, ...EMPTY];
    // An address filters by its parts (address.city, …); the whole field, and a JSON value here, only by being empty.
    case "address": case "json": return EMPTY;
    default: return EMPTY;
  }
}

/** The caller can see the field at all (fields with access "none" are left out of every screen). */
export const isVisible = (f: FieldMeta) => f.access !== "none";

/** Restricted values the caller can't read come back as "[restricted]": they can't be filtered or sorted either. */
export const isRestricted = (f: FieldMeta) => f.sensitivity === "restricted";

export const canFilter = (f: FieldMeta) => isVisible(f) && !isRestricted(f);

/** The API sorts on any readable, unrestricted field except relations, multi-selects, long text, JSON and whole addresses (their parts sort). Never an unknown type. */
const UNSORTABLE = new Set(["relation", "multi_select", "long_text", "json", "address"]);
export const canSort = (f: Pick<FieldMeta, "type" | "access" | "sensitivity">) => isVisible(f as FieldMeta) && !isRestricted(f as FieldMeta) && isKnownType(f.type) && !UNSORTABLE.has(f.type);

/**
 * Whether this caller may set the field: on create (`create`) or on an existing record (`edit`).
 * Needs write on the object and the field; system-computed fields are never written, and create-only
 * fields only on create.
 */
export function canWrite(f: FieldMeta, access: ObjectAccess | undefined, mode: "create" | "edit"): boolean {
  if (!access?.write || f.access !== "write" || f.read_only || !isKnownType(f.type)) return false;
  if (mode === "edit" && f.create_only) return false;
  return true;
}

/** Why a field can't be changed here, for a tooltip; null when it can. */
export function readOnlyReason(f: FieldMeta, access: ObjectAccess | undefined, mode: "create" | "edit"): string | null {
  if (canWrite(f, access, mode)) return null;
  if (!access?.write) return "You can view these records but not change them";
  if (!isKnownType(f.type)) return "This kind of field can't be edited in this version of the app";
  if (f.read_only) return "Set by the system";
  if (f.access !== "write") return "Your role can view this field but not change it";
  if (mode === "edit" && f.create_only) return "Can only be set when the record is created";
  return "Not editable";
}

/** Fields shown for a record or a column chooser: visible to the caller, in describe's order. */
export const visibleFields = (o: ObjectMeta) => o.fields.filter(isVisible);

/** A select or status field's label for a key (the key itself when it is unknown). */
export function optionLabel(f: Pick<FieldMeta, "values">, key: unknown): string {
  if (typeof key !== "string") return "";
  return f.values?.find((v) => v.key === key)?.label ?? key;
}

/**
 * The statuses a status field may move to from `current`, as the server allows: a custom field's own
 * transitions, or a standard field's category moves; never a category only an operation may set.
 * With nothing to go on (a new record, an unknown value), every value but operation-only ones.
 */
export function allowedStatuses(f: FieldMeta, current: unknown): string[] {
  const values = f.values ?? [];
  const opOnly = new Set(f.operation_only_categories ?? []);
  const notOpOnly = values.filter((v) => !opOnly.has(v.category ?? v.key));
  const cur = typeof current === "string" ? values.find((v) => v.key === current) : undefined;
  if (!cur) return notOpOnly.map((v) => v.key);
  if (f.transitions) {
    const next = Object.hasOwn(f.transitions, cur.key) ? f.transitions[cur.key]! : [];
    return [cur.key, ...notOpOnly.filter((v) => next.includes(v.key) && v.key !== cur.key).map((v) => v.key)];
  }
  if (f.category_transitions) {
    const cat = cur.category ?? cur.key;
    const next = Object.hasOwn(f.category_transitions, cat) ? f.category_transitions[cat]! : [];
    return [cur.key, ...notOpOnly.filter((v) => v.key !== cur.key && (next.includes(v.category ?? v.key) || (v.category ?? v.key) === cat)).map((v) => v.key)];
  }
  return [cur.key, ...notOpOnly.filter((v) => v.key !== cur.key).map((v) => v.key)];
}

/** Tone for a status or select badge from its category, so colours mean the same everywhere. */
export function toneFor(category: string | undefined): "neutral" | "accent" | "success" | "danger" | "warning" | "info" {
  switch (category) {
    case "won": case "done": case "customer": case "converted": case "qualified": return "success";
    case "lost": case "disqualified": case "cancelled": case "former_customer": return "danger";
    case "working": case "in_progress": case "opportunity": return "info";
    case "new": case "open": case "lead": return "accent";
    default: return "neutral";
  }
}

// --- Form values ------------------------------------------------------------------------------------

/** A form's value for a field: text-like inputs hold strings while typing (JSON and durations too); an address holds its parts; the rest hold API values. */
export type FormValue = string | number | boolean | string[] | Record<string, string> | null;

/** The initial form value from a record's value (or a field's default on create). */
export function toFormValue(f: FieldMeta, v: unknown): FormValue {
  if (v === undefined || v === null) {
    if (f.type === "multi_select" || (f.type === "relation" && f.relation?.cardinality === "many_to_many")) return [];
    if (f.type === "boolean" || f.type === "rating") return null;
    if (f.type === "address") return {};
    return "";
  }
  switch (f.type) {
    case "number": case "currency": case "percent": return typeof v === "number" ? String(v) : String(v);
    case "rating": return typeof v === "number" ? v : null;
    case "duration": return typeof v === "number" ? formatDuration(v) : String(v);
    case "json": return JSON.stringify(v, null, 2);
    case "address": {
      if (typeof v !== "object" || Array.isArray(v)) return {};
      const out: Record<string, string> = {};
      for (const p of addressParts(f)) {
        const x = (v as Record<string, unknown>)[p.name];
        if (typeof x === "string") out[p.name] = x;
      }
      return out;
    }
    case "boolean": return v === true;
    case "multi_select": return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    case "relation": return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? v : "";
    default: return typeof v === "string" ? v : String(v);
  }
}

/** The API value for a form value: empty becomes null, numbers become numbers. */
export function toApiValue(f: FieldMeta, v: FormValue | undefined): unknown {
  if (v === undefined) return null;
  switch (f.type) {
    case "number": case "currency": case "percent": {
      if (typeof v === "number") return v;
      if (typeof v !== "string" || v.trim() === "") return null;
      const n = Number(v.trim().replace(/,/g, ""));
      return Number.isFinite(n) ? n : v;
    }
    case "boolean": return v === null || v === "" ? null : v === true;
    case "rating": return typeof v === "number" ? v : null;
    case "duration": {
      if (typeof v === "number") return v;
      if (typeof v !== "string" || v.trim() === "") return null;
      return parseDuration(v) ?? v;
    }
    case "json": {
      if (typeof v !== "string" || v.trim() === "") return null;
      try {
        return JSON.parse(v) as unknown;
      } catch {
        // Kept as typed: the field's check reports it.
        return { [INVALID_JSON]: v };
      }
    }
    case "address": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return null;
      const out: Record<string, string> = {};
      for (const [k, x] of Object.entries(v)) if (typeof x === "string" && x.trim() !== "") out[k] = x.trim();
      return Object.keys(out).length ? out : null;
    }
    case "multi_select": return Array.isArray(v) ? v : [];
    case "relation":
      if (f.relation?.cardinality === "many_to_many") return Array.isArray(v) ? v : [];
      return typeof v === "string" && v ? v : null;
    default:
      return typeof v === "string" ? (v.trim() === "" ? null : f.type === "long_text" ? v : v.trim()) : v;
  }
}

/** Marks JSON text that didn't parse, so its check can say so (never sent: the check fails first). */
export const INVALID_JSON = "__invalid_json__";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[+0-9 ()\-.x]{3,50}$/;

/** A JS RegExp for a field's RE2 pattern, or null when it can't be compiled here (the server still checks it). */
function patternOf(p: string | undefined): RegExp | null {
  if (!p) return null;
  try {
    return new RegExp(p, "u");
  } catch {
    return null;
  }
}

/**
 * Client-side checks for one field, as a zod schema over the API value. They catch the common mistakes
 * before a round trip; anything they miss the server reports, and its messages land on the same fields.
 */
export function fieldSchema(f: FieldMeta, opts: { required: boolean }): z.ZodType {
  const v = f.validation ?? {};
  let s: z.ZodType;
  const text = (max: number) => {
    let t = z.string().max(Math.min(v.max_length ?? max, max), `Must be at most ${Math.min(v.max_length ?? max, max)} characters`);
    const re = patternOf(v.pattern);
    if (re) t = t.regex(re, "Doesn't match the required format");
    return t;
  };
  switch (f.type) {
    case "text": case "long_text": s = text(TEXT_MAX[f.type]!); break;
    case "email": s = z.string().regex(EMAIL, "Enter a valid email address").max(320); break;
    case "phone": s = z.string().regex(PHONE, "Enter a phone number (digits, spaces, + ( ) - . x)"); break;
    case "url": s = z.string().refine((x) => {
      try {
        const u = new URL(x);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    }, "Enter a full http(s) URL, like https://example.com"); break;
    case "number": case "currency": {
      let n = z.number({ error: "Enter a number" }).refine(Number.isFinite, "Enter a number");
      if (v.min !== undefined) n = n.refine((x) => x >= v.min!, `Must be at least ${v.min}`);
      if (v.max !== undefined) n = n.refine((x) => x <= v.max!, `Must be at most ${v.max}`);
      s = n;
      break;
    }
    case "boolean": s = z.boolean(); break;
    case "rating": {
      const max = f.max ?? 5;
      s = z.number({ error: "Choose a rating" }).int("Choose a whole number").min(1, `Choose 1 to ${max}`).max(max, `Choose 1 to ${max}`);
      break;
    }
    case "percent": {
      let n = z.number({ error: "Enter a percentage" }).refine(Number.isFinite, "Enter a percentage");
      const lo = f.min ?? v.min;
      const hi = f.max ?? v.max;
      if (lo !== undefined) n = n.refine((x) => x >= lo, `Must be at least ${lo}%`);
      if (hi !== undefined) n = n.refine((x) => x <= hi, `Must be at most ${hi}%`);
      n = n.refine((x) => decimals(x) <= PERCENT_DECIMALS, `Use at most ${PERCENT_DECIMALS} decimal places`);
      s = n;
      break;
    }
    case "duration": {
      // Whole seconds from 0 to DURATION_MAX, within the field's own validation.min/max when it has them (describe sends no min/max of its own).
      let n = z.number({ error: "Enter a duration like 1h 30m, or seconds" }).int("Enter whole seconds").min(0, "Can't be negative").max(DURATION_MAX, "That's longer than the longest duration (about 3,000 years)");
      if (v.min !== undefined) n = n.min(v.min, `Must be at least ${formatDuration(v.min)}`);
      if (v.max !== undefined) n = n.max(v.max, `Must be at most ${formatDuration(v.max)}`);
      s = n;
      break;
    }
    case "json": s = z.unknown().superRefine((x, ctx) => {
      if (x && typeof x === "object" && !Array.isArray(x) && Object.hasOwn(x, INVALID_JSON)) ctx.addIssue({ code: "custom", message: "This isn't valid JSON" });
      else if (new TextEncoder().encode(JSON.stringify(x)).length > JSON_MAX_BYTES) ctx.addIssue({ code: "custom", message: "Must be at most 16 KB of JSON" });
    }); break;
    case "address": s = z.record(z.string(), z.string()).superRefine((a, ctx) => {
      for (const p of addressParts(f)) {
        const x = a[p.name];
        const max = Object.hasOwn(ADDRESS_PART_MAX, p.name) ? ADDRESS_PART_MAX[p.name]! : 200;
        if (p.name !== "country" && typeof x === "string" && x.length > max) ctx.addIssue({ code: "custom", message: `${p.label ?? p.name} must be at most ${max} characters` });
      }
      if (a.country !== undefined && !isCountryCode(a.country)) ctx.addIssue({ code: "custom", message: "Choose a country from the list" });
    }); break;
    case "date": s = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date"); break;
    case "datetime": s = z.string().refine((x) => !Number.isNaN(Date.parse(x)), "Enter a date and time"); break;
    case "single_select": case "status": s = f.values?.length ? z.enum(f.values.map((x) => x.key) as [string, ...string[]], { error: "Pick one of the options" }) : z.string(); break;
    case "multi_select": s = z.array(z.string()); break;
    case "relation": s = f.relation?.cardinality === "many_to_many" ? z.array(z.string()) : z.string(); break;
    default: s = z.unknown();
  }
  if (opts.required) {
    const isEmpty = (x: unknown) => x === null || x === undefined || x === "" || (Array.isArray(x) && x.length === 0);
    return z.any().superRefine((x, ctx) => {
      if (isEmpty(x)) {
        ctx.addIssue({ code: "custom", message: "Required" });
        return;
      }
      const r = s.safeParse(x);
      if (!r.success) ctx.addIssue({ code: "custom", message: r.error.issues[0]?.message ?? "Not valid" });
    });
  }
  return z.any().superRefine((x, ctx) => {
    if (x === null || x === undefined || (Array.isArray(x) && x.length === 0)) return;
    const r = s.safeParse(x);
    if (!r.success) ctx.addIssue({ code: "custom", message: r.error.issues[0]?.message ?? "Not valid" });
  });
}

/** Validates API values for the given fields; returns messages by field name. */
export function validateValues(fields: FieldMeta[], values: Record<string, unknown>, mode: "create" | "edit"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (!Object.hasOwn(values, f.name)) continue;
    const required = Boolean(f.required) && !(mode === "create" && (f.default !== undefined || f.initial !== undefined));
    const r = fieldSchema(f, { required }).safeParse(values[f.name]);
    if (!r.success) out[f.name] = r.error.issues[0]?.message ?? "Not valid";
  }
  return out;
}

// --- Picking fields for screens -----------------------------------------------------------------

/** Default list columns: the first six readable, unrestricted, short fields, skipping the display field (the Name column shows it). */
export function defaultColumns(o: ObjectMeta): string[] {
  // Standard objects name records from a name or title field without declaring a display field.
  const naming = o.display_field ?? visibleFields(o).find((f) => f.type === "text" && (f.name === "name" || f.name === "title"))?.name;
  return visibleFields(o)
    .filter((f) => f.type !== "long_text" && f.type !== "json" && f.name !== naming && !isRestricted(f))
    .slice(0, 6)
    .map((f) => f.name);
}

/** Many-to-one relations worth showing by name on a list or record (include= takes at most five). */
export function includable(o: ObjectMeta, among?: string[]): string[] {
  // Pipelines and stages are named from describe's pipelines, so they need no include.
  const named = (to: string | undefined) => (to === "pipeline" || to === "stage") && Boolean(o.pipelines?.length);
  const rels = visibleFields(o).filter((f) => f.type === "relation" && f.relation?.cardinality !== "many_to_many" && !named(f.relation?.to) && (!among || among.includes(f.name)));
  // People first (owner, assignee), then records, then pipelines and stages.
  const rank = (f: FieldMeta) => (f.relation?.to === "user" ? 0 : isEntity(f.relation?.to) ? 2 : 1);
  return [...rels].sort((a, b) => rank(a) - rank(b)).slice(0, 5).map((f) => f.name);
}

/** Fields a header shows as key facts: statuses, money, the owner, a select or two. */
export function keyFacts(o: ObjectMeta): FieldMeta[] {
  const vis = visibleFields(o).filter((f) => !isRestricted(f));
  const pick = [
    ...vis.filter((f) => f.type === "status"),
    ...vis.filter((f) => f.type === "relation" && f.relation?.to === "stage"),
    ...vis.filter((f) => f.type === "currency"),
    ...vis.filter((f) => f.type === "relation" && f.relation?.to === "user"),
    ...vis.filter((f) => f.type === "single_select" && !f.read_only),
    ...vis.filter((f) => f.type === "date"),
  ];
  return [...new Map(pick.map((f) => [f.name, f])).values()].slice(0, 5);
}
