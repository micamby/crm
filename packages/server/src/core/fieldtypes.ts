import { RE2JS, RE2JSException } from "re2js";
import type { FieldOptions, FieldType, JsonKind, JsonShape } from "./catalog.js";
import { COUNTRIES } from "./countries.js";

export interface FieldLike {
  api_name: string;
  type: FieldType;
  options: FieldOptions;
  validation: { min?: number; max?: number; max_length?: number; pattern?: string };
}

export class FieldValueError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
  }
}

// ----------------------------------------------------------------------------------------------
// The field type registry: what each type supports, read by every layer (queries, sorts, aggregates,
// uniqueness, search text, CSV, retyping, the OpenAPI document, describe). A type added to FieldType
// must be added here, and test/fieldtypes.test.ts runs every type through each layer from this table.

export type FilterOp = "eq" | "neq" | "in" | "not_in" | "gt" | "gte" | "lt" | "lte" | "contains" | "starts_with" | "is_null";
export type MeasureOp = "sum" | "avg" | "min" | "max";
type Rule = "min" | "max" | "max_length" | "pattern";

export interface TypeInfo {
  /** The SQL type a stored value is compared as in filters, sorts and aggregates. jsonb: compared as JSON, never cast. */
  cast: "text" | "numeric" | "boolean" | "date" | "timestamptz" | "uuid" | "jsonb";
  /** Filter operators on the field itself (parts and paths have their own, below). */
  ops: readonly FilterOp[];
  sort: boolean;
  /** Can be an aggregate's group_by (relations: many-to-one only). */
  group: boolean;
  /** Aggregate measures besides count, which every field has. */
  measures: readonly MeasureOp[];
  unique: boolean;
  /** Values go into the record's search_text (restricted fields never do). */
  search: boolean;
  validation: readonly Rule[];
  /** Type-specific options a field may set (select values, relation targets and status rules are checked in core/schema.ts). */
  options: readonly ("max" | "shape")[];
  /** CSV: one text cell, a ;-joined list, a JSON cell, or one column per part (field.part). */
  csv: "text" | "list" | "json" | "parts";
  /** The one type change that keeps every stored value's meaning; rewrite: stored values are converted. */
  retype?: { to: FieldType; rewrite: boolean };
  /** The value's JSON Schema in responses (null aside). */
  schema: Record<string, unknown>;
}

const TEXT_OPS: FilterOp[] = ["eq", "neq", "in", "not_in", "contains", "starts_with", "is_null"];
const ORDER_OPS: FilterOp[] = ["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "is_null"];
const SELECT_OPS: FilterOp[] = ["eq", "neq", "in", "not_in", "starts_with", "is_null"];
const EQ_OPS: FilterOp[] = ["eq", "neq", "in", "not_in", "is_null"];
const plainText = (sort: boolean, unique: boolean, schema: Record<string, unknown>, search = true): TypeInfo => ({
  cast: "text", ops: TEXT_OPS, sort, group: false, measures: [], unique, search, validation: [], options: [], csv: "text", schema,
});

export const TYPE_INFO: Readonly<Record<FieldType, TypeInfo>> = {
  text: { ...plainText(true, true, { type: "string" }), group: true, validation: ["max_length", "pattern"], retype: { to: "long_text", rewrite: false } },
  long_text: { ...plainText(false, false, { type: "string" }, false), validation: ["max_length", "pattern"] },
  email: plainText(true, true, { type: "string", format: "email" }),
  phone: plainText(true, true, { type: "string" }),
  url: plainText(true, true, { type: "string", format: "uri" }),
  number: { cast: "numeric", ops: ORDER_OPS, sort: true, group: false, measures: ["sum", "avg", "min", "max"], unique: true, search: false,
    validation: ["min", "max"], options: [], csv: "text", retype: { to: "currency", rewrite: true }, schema: { type: "number" } },
  currency: { cast: "numeric", ops: ORDER_OPS, sort: true, group: false, measures: ["sum", "avg", "min", "max"], unique: false, search: false,
    validation: ["min", "max"], options: [], csv: "text", schema: { type: "number", description: "Major units in the workspace currency" } },
  boolean: { cast: "boolean", ops: EQ_OPS, sort: true, group: true, measures: [], unique: false, search: false, validation: [], options: [], csv: "text",
    schema: { type: "boolean" } },
  date: { cast: "date", ops: ORDER_OPS, sort: true, group: true, measures: ["min", "max"], unique: false, search: false, validation: [], options: [],
    csv: "text", schema: { type: "string", format: "date" } },
  datetime: { cast: "timestamptz", ops: ORDER_OPS, sort: true, group: true, measures: ["min", "max"], unique: false, search: false, validation: [],
    options: [], csv: "text", schema: { type: "string", format: "date-time" } },
  single_select: { cast: "text", ops: SELECT_OPS, sort: true, group: true, measures: [], unique: false, search: false, validation: [], options: [],
    csv: "text", retype: { to: "multi_select", rewrite: true }, schema: { type: "string" } },
  status: { cast: "text", ops: SELECT_OPS, sort: true, group: true, measures: [], unique: false, search: false, validation: [], options: [], csv: "text",
    schema: { type: "string" } },
  multi_select: { cast: "text", ops: ["contains", "is_null"], sort: false, group: false, measures: [], unique: false, search: false, validation: [],
    options: [], csv: "list", schema: { type: "array", items: { type: "string" } } },
  relation: { cast: "uuid", ops: EQ_OPS, sort: false, group: true, measures: [], unique: false, search: false, validation: [], options: [], csv: "list",
    schema: { type: "string", description: "A record ID" } },
  address: { cast: "jsonb", ops: ["is_null"], sort: false, group: false, measures: [], unique: false, search: true, validation: [], options: [],
    csv: "parts", schema: {
      type: "object", additionalProperties: false, required: ["line1", "line2", "city", "region", "postal_code", "country", "display"],
      description: "A postal address. Filter, sort and group by its parts (field.city, field.country, …); display is built from the parts",
      properties: {
        line1: { type: ["string", "null"] }, line2: { type: ["string", "null"] }, city: { type: ["string", "null"] }, region: { type: ["string", "null"] },
        postal_code: { type: ["string", "null"] }, country: { type: ["string", "null"], pattern: "^[A-Z]{2}$", description: "ISO 3166-1 alpha-2" },
        display: { type: "string", description: "One line for display; read-only (ignored on input)" },
      },
    } },
  json: { cast: "jsonb", ops: ["is_null"], sort: false, group: false, measures: [], unique: false, search: false, validation: [], options: ["shape"],
    csv: "json", schema: { description: "Any JSON value, up to 16 KB as stored and 10 levels deep; numbers within ±1e15 and at most 32 characters written out. "
      + "Filter with field.key.key eq/neq/is_null" } },
  rating: { cast: "numeric", ops: ORDER_OPS, sort: true, group: true, measures: ["avg", "min", "max"], unique: false, search: false, validation: [],
    options: ["max"], csv: "text", retype: { to: "number", rewrite: false }, schema: { type: "integer", minimum: 1, maximum: 10, description: "1 to the field's max" } },
  percent: { cast: "numeric", ops: ORDER_OPS, sort: true, group: false, measures: ["avg", "min", "max"], unique: false, search: false,
    validation: ["min", "max"], options: [], csv: "text", retype: { to: "number", rewrite: false },
    schema: { type: "number", description: "Percentage points: 12.5 means 12.5%" } },
  duration: { cast: "numeric", ops: ORDER_OPS, sort: true, group: false, measures: ["sum", "avg", "min", "max"], unique: false, search: false,
    validation: ["min", "max"], options: [], csv: "text", retype: { to: "number", rewrite: false },
    schema: { type: "integer", minimum: 0, description: "Whole seconds (input also takes an ISO 8601 duration such as PT1H30M)" } },
};

export const FIELD_TYPES = Object.keys(TYPE_INFO) as [FieldType, ...FieldType[]];
export const isFieldType = (t: unknown): t is FieldType => typeof t === "string" && Object.hasOwn(TYPE_INFO, t);

// --- address ----------------------------------------------------------------------------------

/** The parts of an address, in display order, with the longest value each takes. */
export const ADDRESS_PARTS = { line1: 200, line2: 200, city: 100, region: 100, postal_code: 20, country: 2 } as const;
export type AddressPart = keyof typeof ADDRESS_PARTS;
export const ADDRESS_PART_NAMES = Object.keys(ADDRESS_PARTS) as AddressPart[];
/** Parts an aggregate can group by: the ones many records share. */
export const ADDRESS_GROUP_PARTS: readonly AddressPart[] = ["country", "region", "city"];
export const isAddressPart = (p: string): p is AddressPart => Object.hasOwn(ADDRESS_PARTS, p);
/** C0 controls and DEL: an address part is one line of plain text. */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}
/**
 * Characters that make one line of text display as something else: C1 controls, the Unicode line and paragraph
 * separators (a line break to many renderers), and the bidi embeddings, overrides and isolates (which reorder
 * what follows, so "US" could show as "SU"). Refused in single-line text the newer types take.
 */
export const DISGUISING = /[\u0080-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
/** An unpaired UTF-16 surrogate: Postgres can't store one in jsonb, so it is refused as input rather than failing the write. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const wellFormed = (s: string) => !LONE_SURROGATE.test(s);

/**
 * One line for showing: line1, line2, city, region and postal code, country name, joined with ", ". Parts left
 * empty are skipped. A part may itself hold ", " (Suite 5, Building B), so display is never parsed: the parts are
 * the address, display is ignored on input, and CSV carries one column per part, never display.
 */
export function formatAddress(a: Partial<Record<AddressPart, string | null>>): string {
  const cityLine = [a.city, [a.region, a.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return [a.line1, a.line2, cityLine, a.country ? COUNTRIES.get(a.country) ?? a.country : null].filter(Boolean).join(", ");
}

function normalizeAddress(fail: (m: string) => never, value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`must be an address object with any of: ${ADDRESS_PART_NAMES.join(", ")}`);
  const out: Record<string, string> = {};
  for (const k of Object.keys(value as object)) {
    if (k !== "display" && !isAddressPart(k)) fail(`has an unknown part "${k.slice(0, 40)}"; an address takes ${ADDRESS_PART_NAMES.join(", ")}`);
  }
  const display = (value as Record<string, unknown>).display;
  if (display !== undefined && display !== null && typeof display !== "string") fail("display is built from the parts; send a string or leave it out");
  for (const part of ADDRESS_PART_NAMES) {
    const raw = Object.hasOwn(value as object, part) ? (value as Record<string, unknown>)[part] : undefined;
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") fail(`${part} must be text`);
    const v = raw.trim();
    if (v === "") continue;
    if (hasControl(v) || DISGUISING.test(v) || !wellFormed(v)) fail(`${part} must be one line of plain text, without control, line separator or bidi characters`);
    if (part === "country") {
      const code = v.toUpperCase();
      if (!/^[A-Z]{2}$/.test(code) || !COUNTRIES.has(code)) fail("country must be an ISO 3166-1 alpha-2 code, e.g. US, GB, DE");
      out.country = code;
    } else {
      // Counted as text fields count (UTF-16 code units), so a part fits wherever a text field of that length does.
      if (v.length > ADDRESS_PARTS[part]) fail(`${part} must be at most ${ADDRESS_PARTS[part]} characters`);
      out[part] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

// --- json ---------------------------------------------------------------------------------------

/**
 * A json value's limits: its size as Postgres stores and returns it (jsonb text, UTF-8 bytes), nesting, a key's
 * length, and a number's length written out in full. Postgres keeps a JSON number as an exact decimal, so 1e308
 * is 309 digits on every read; a number is refused past ±1e15 (MAX_NUMBER, as number fields) or when its plain
 * decimal form is longer than `numberChars` (which bounds tiny ones, from about 1e-30). Ordinary numbers, all
 * of JavaScript's 17 significant digits included, fit.
 */
export const JSON_LIMITS = { bytes: 16_384, depth: 10, keyLength: 200, numberChars: 32 } as const;

/** A finite number written out without an exponent, as Postgres's numeric prints it from JavaScript's shortest form: 1e-7 is 0.0000001. */
export function plainDecimal(n: number): string {
  const s = String(n);
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (!m) return s;
  const [, sign, int, frac = "", e] = m;
  const exp = Number(e);
  const digits = int! + frac;
  if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`;
  return sign + (digits.length > exp + 1 ? `${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}` : digits + "0".repeat(exp + 1 - digits.length));
}

/** Why a number can't be kept in a json value (or a json path filter), or null. */
export function jsonNumberProblem(n: number): string | null {
  if (!Number.isFinite(n)) return "numbers must be finite";
  if (Math.abs(n) > MAX_NUMBER || plainDecimal(n).length > JSON_LIMITS.numberChars) {
    return `numbers must be between -${MAX_NUMBER} and ${MAX_NUMBER}, with at most ${JSON_LIMITS.numberChars} characters written out in full`;
  }
  return null;
}

/** The UTF-8 length of a clean JSON value as jsonb text: what Postgres stores and sends back on every read (", " and ": " separators, numbers in full). */
export function storedJsonBytes(v: unknown): number {
  if (v === null || typeof v === "boolean") return String(v).length;
  if (typeof v === "number") return plainDecimal(v).length;
  if (typeof v === "string") return Buffer.byteLength(JSON.stringify(v));
  if (Array.isArray(v)) return 2 + v.reduce<number>((n, x) => n + storedJsonBytes(x), 0) + Math.max(0, v.length - 1) * 2;
  const entries = Object.entries(v as object);
  return 2 + entries.reduce<number>((n, [k, x]) => n + Buffer.byteLength(JSON.stringify(k)) + 2 + storedJsonBytes(x), 0) + Math.max(0, entries.length - 1) * 2;
}
/** Keys that name Object.prototype members: harmless in jsonb, but a client that copies the value into a plain object can be hijacked by them. */
const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const JSON_KINDS: JsonKind[] = ["object", "array", "string", "number", "integer", "boolean", "null"];
const kindOf = (v: unknown): JsonKind => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v as JsonKind);
const isKind = (v: unknown, k: JsonKind) => (k === "integer" ? Number.isInteger(v) : k === "number" ? typeof v === "number" : kindOf(v) === k);
const SHAPE_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/** A clean copy of a JSON value (plain objects and arrays only), or the reason it is refused. Depth-bounded, so a hostile nesting stops early. */
function cleanJson(v: unknown, depth: number): unknown {
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") {
    const problem = jsonNumberProblem(v);
    if (problem) throw new Error(problem);
    return v;
  }
  if (typeof v === "string") {
    if (v.includes("\0") || !wellFormed(v)) throw new Error("text must not contain NUL (\\u0000) or unpaired surrogates");
    return v;
  }
  if (depth >= JSON_LIMITS.depth) throw new Error(`nests more than ${JSON_LIMITS.depth} levels deep`);
  if (Array.isArray(v)) return v.map((x) => cleanJson(x, depth + 1));
  const proto = typeof v === "object" ? Object.getPrototypeOf(v) : undefined;
  if (proto !== Object.prototype && proto !== null) throw new Error("holds something that is not a JSON value");
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v as object)) {
    if (PROTO_KEYS.has(k)) throw new Error(`has a key named "${k}", which is not allowed`);
    if (k.length > JSON_LIMITS.keyLength || k.includes("\0") || !wellFormed(k)) throw new Error(`has a key that is too long or not plain text`);
    out[k] = cleanJson((v as Record<string, unknown>)[k], depth + 1);
  }
  return out;
}

/** Checks a json field's options.shape when the field is saved. */
export function shapeProblem(shape: unknown): string | null {
  if (typeof shape !== "object" || shape === null || Array.isArray(shape)) return "options.shape must be an object";
  const s = shape as Record<string, unknown>;
  for (const k of Object.keys(s)) if (!["type", "required", "properties", "additional_properties"].includes(k)) return `options.shape takes type, required, properties and additional_properties, not "${k.slice(0, 40)}"`;
  if (s.type !== undefined && !JSON_KINDS.includes(s.type as JsonKind)) return `options.shape.type is one of ${JSON_KINDS.join(", ")}`;
  const keyed = s.required !== undefined || s.properties !== undefined || s.additional_properties !== undefined;
  if (keyed && s.type !== undefined && s.type !== "object") return "options.shape.required, properties and additional_properties apply to objects only";
  if (s.required !== undefined && (!Array.isArray(s.required) || s.required.length > 50 || s.required.some((k) => typeof k !== "string" || !SHAPE_KEY.test(k) || PROTO_KEYS.has(k)))) {
    return "options.shape.required is a list of at most 50 key names (letters, digits, _ . -)";
  }
  if (s.properties !== undefined) {
    if (typeof s.properties !== "object" || s.properties === null || Array.isArray(s.properties)) return "options.shape.properties maps key names to kinds";
    const entries = Object.entries(s.properties);
    if (entries.length > 50) return "options.shape.properties names at most 50 keys";
    for (const [k, kind] of entries) {
      if (!SHAPE_KEY.test(k) || PROTO_KEYS.has(k)) return `options.shape.properties: "${k.slice(0, 40)}" is not a usable key name`;
      if (!JSON_KINDS.includes(kind as JsonKind)) return `options.shape.properties.${k} is one of ${JSON_KINDS.join(", ")}`;
    }
  }
  if (s.additional_properties !== undefined && typeof s.additional_properties !== "boolean") return "options.shape.additional_properties is true or false";
  return null;
}

/** Why `v` doesn't fit `shape`, or null. */
function shapeMismatch(shape: JsonShape, v: unknown): string | null {
  const keyed = shape.required !== undefined || shape.properties !== undefined || shape.additional_properties !== undefined;
  const type = shape.type ?? (keyed ? "object" : undefined);
  if (type && !isKind(v, type)) return `must be ${type === "integer" || type === "array" || type === "object" ? "an" : "a"} ${type}`;
  if (kindOf(v) !== "object") return null;
  const o = v as Record<string, unknown>;
  const missing = (shape.required ?? []).filter((k) => !Object.hasOwn(o, k));
  if (missing.length) return `is missing required key(s): ${missing.join(", ")}`;
  for (const [k, kind] of Object.entries(shape.properties ?? {})) {
    if (Object.hasOwn(o, k) && !isKind(o[k], kind)) return `key "${k}" must be ${kind}`;
  }
  if (shape.additional_properties === false) {
    const extra = Object.keys(o).filter((k) => !Object.hasOwn(shape.properties ?? {}, k));
    if (extra.length) return `has key(s) the field's shape doesn't allow: ${extra.slice(0, 5).map((k) => k.slice(0, 40)).join(", ")}`;
  }
  return null;
}

function normalizeJson(fail: (m: string) => never, field: FieldLike, value: unknown): unknown {
  let clean: unknown;
  try {
    clean = cleanJson(value, 0);
  } catch (e) {
    return fail((e as Error).message);
  }
  if (storedJsonBytes(clean) > JSON_LIMITS.bytes) fail(`must be at most ${JSON_LIMITS.bytes / 1024} KB as stored (jsonb text)`);
  const shape = field.options.shape;
  const problem = shape ? shapeMismatch(shape, clean) : null;
  if (problem) fail(`does not fit the field's shape: it ${problem}`);
  return clean;
}

/** A path into a json value for filters (field.key.key): 1 to 4 keys or array indexes. */
export const JSON_PATH = { maxKeys: 4, key: /^[A-Za-z0-9_-]{1,64}$/ } as const;

// --- rating, percent, duration ------------------------------------------------------------------

export const RATING = { defaultMax: 5, maxMax: 10 } as const;
export const ratingMax = (field: { options: FieldOptions }) => field.options.max ?? RATING.defaultMax;
/** Percent values: percentage points (12.5 means 12.5%), kept to 4 decimals, between these unless validation says otherwise. */
export const PERCENT = { defaultMin: 0, defaultMax: 100, limit: 1e9, decimals: 4 } as const;
/** Durations: whole seconds from 0 to about 3,000 years. */
export const DURATION_MAX = 1e11;
const ISO_DURATION = /^P(?:(\d{1,9})W)?(?:(\d{1,9})D)?(?:T(?:(\d{1,9})H)?(?:(\d{1,9})M)?(?:(\d{1,9})S)?)?$/i;

/** Seconds from a number, numeric text or an ISO 8601 duration (weeks, days, hours, minutes, whole seconds); null when it is none of these. */
export function parseDuration(v: unknown): number | string {
  if (typeof v === "number") return Number.isInteger(v) ? v : "must be a whole number of seconds";
  if (typeof v !== "string" || v.length > 40) return "must be a number of seconds or an ISO 8601 duration such as PT1H30M";
  const s = v.trim();
  if (/^\d{1,15}$/.test(s)) return Number(s);
  if (/^P/i.test(s) && /[YM]/i.test(s.split(/T/i)[0]!)) return "takes weeks, days, hours, minutes and seconds; years and months have no fixed length";
  const m = ISO_DURATION.exec(s);
  if (!m || s.length < 3 || /T$/i.test(s)) return "must be a number of seconds or an ISO 8601 duration such as PT1H30M (whole seconds, no years or months)";
  const [w, d, h, min, sec] = m.slice(1).map((x) => Number(x ?? 0));
  return w! * 604_800 + d! * 86_400 + h! * 3_600 + min! * 60 + sec!;
}

/** Compact text for a duration: 1d 2h 3m 4s (zero units left out; 0s for zero). */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "";
  let rest = Math.round(Math.abs(seconds));
  const parts: string[] = [];
  for (const [unit, size] of [["d", 86_400], ["h", 3_600], ["m", 60], ["s", 1]] as const) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n) parts.push(`${n}${unit}`);
  }
  return `${seconds < 0 ? "-" : ""}${parts.join(" ") || "0s"}`;
}

/** A percent value from a number, or text such as "12.5" or "12.5%". */
export function parsePercent(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.length > 40) return null;
  const m = /^\s*([+-]?\d+(?:\.\d+)?)\s*%?\s*$/.exec(v);
  return m ? Number(m[1]) : null;
}

/** The text a value adds to a record's search_text: text as it is, an address's parts. */
export function searchString(type: FieldType, v: unknown): string | null {
  if (typeof v === "string") return v;
  if (type === "address" && v && typeof v === "object") {
    return ADDRESS_PART_NAMES.map((p) => (v as Record<string, unknown>)[p]).filter((x): x is string => typeof x === "string" && x !== "").join(" ") || null;
  }
  return null;
}

/** Equal as stored: for comparing an imported cell with the current value whatever form either came in. */
export function sameStored(field: FieldLike, a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => {
    try {
      return JSON.stringify(toStorage(field.type, normalizeInput(field, v ?? null)));
    } catch {
      return JSON.stringify(v ?? null);
    }
  };
  return norm(a) === norm(b);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[+0-9 ()\-.x]{3,50}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Largest number a number field stores, and a filter takes (core/query.ts). Within it a number keeps 15
 * significant digits through every round trip, and its text sorts and pages like any other.
 */
export const MAX_NUMBER = 1e15;

/** Longest text each type accepts; `validation.max_length` can lower it but not raise it. */
export const TEXT_MAX = { text: 2_000, long_text: 100_000 } as const;
export const PATTERN_MAX_LENGTH = 500;
/** RE2 program size: a rough cost measure. Matching is O(program size x input length). */
const PATTERN_MAX_PROGRAM = 2_000;
/**
 * Upper bound on program size x input length for one check: about 50 ms in the worst case
 * (measured with re2js 2.9.1), so long_text fields need a short pattern or a lower max_length.
 */
const PATTERN_BUDGET = 5_000_000;

/** A tenant-supplied pattern that RE2 cannot compile, or that is too expensive to run. */
export class PatternError extends Error {}

const patterns = new Map<string, RE2JS>();

/**
 * Compiles `validation.pattern` with RE2 (re2js), which matches in linear time, so no pattern
 * can freeze the event loop. JavaScript-only syntax (lookaround, backreferences) is rejected.
 */
export function compilePattern(pattern: string): RE2JS {
  const hit = patterns.get(pattern);
  if (hit) return hit;
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > PATTERN_MAX_LENGTH) {
    throw new PatternError(`must be 1 to ${PATTERN_MAX_LENGTH} characters`);
  }
  let re: RE2JS;
  try {
    re = RE2JS.compile(pattern);
  } catch (e) {
    if (e instanceof RE2JSException) throw new PatternError(`is not a supported regular expression (RE2 syntax): ${e.message}`);
    throw e;
  }
  if (re.programSize() > PATTERN_MAX_PROGRAM) throw new PatternError("is too complex; simplify it");
  if (patterns.size >= 1_000) patterns.delete(patterns.keys().next().value!);
  patterns.set(pattern, re);
  return re;
}

/** Fails closed on a pattern saved before patterns were checked, which RE2 cannot run: a 422, not a 500. */
function storedPattern(field: FieldLike, pattern: string): RE2JS {
  try {
    return compilePattern(pattern);
  } catch (e) {
    if (e instanceof PatternError) {
      throw new FieldValueError(field.api_name, "has a format rule (validation.pattern) that is no longer supported; an admin must update the field");
    }
    throw e;
  }
}

/**
 * Checks a field's `validation` rules and `default` when the field is saved, so a bad rule is
 * refused once instead of breaking every later write. Returns the problem, or null.
 */
export function fieldRulesProblem(field: FieldLike, defaultValue?: unknown): string | null {
  const raw = field.validation as unknown;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw)) return "validation must be an object";
    const v = raw as Record<string, unknown>;
    const isText = field.type === "text" || field.type === "long_text";
    const allowed: readonly string[] = TYPE_INFO[field.type]?.validation ?? [];
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      if (!allowed.includes(k)) {
        return allowed.length ? `validation.${k} does not apply to ${field.type} fields (use ${allowed.join(" or ")})` : `${field.type} fields take no validation rules`;
      }
    }
    for (const k of ["min", "max"] as const) {
      if (v[k] !== undefined && (typeof v[k] !== "number" || !Number.isFinite(v[k]))) return `validation.${k} must be a number`;
    }
    if (typeof v.min === "number" && typeof v.max === "number" && v.min > v.max) return "validation.min cannot be greater than validation.max";
    if (v.max_length !== undefined) {
      const cap = isText ? TEXT_MAX[field.type as "text" | "long_text"] : 0;
      if (!Number.isInteger(v.max_length) || (v.max_length as number) < 1 || (v.max_length as number) > cap) {
        return `validation.max_length must be a whole number from 1 to ${cap}`;
      }
    }
    if (v.pattern !== undefined) {
      if (typeof v.pattern !== "string") return "validation.pattern must be a string";
      if (!isText) return `${field.type} fields take no pattern`;
      let re: RE2JS;
      try {
        re = compilePattern(v.pattern);
      } catch (e) {
        if (e instanceof PatternError) return `validation.pattern ${e.message}`;
        throw e;
      }
      const longest = Math.min(typeof v.max_length === "number" ? v.max_length : Infinity, TEXT_MAX[field.type as "text" | "long_text"]);
      if (re.programSize() * longest > PATTERN_BUDGET) {
        return `validation.pattern is too complex for text up to ${longest} characters; simplify it or set a lower validation.max_length`;
      }
    }
  }
  const opts = (field.options ?? {}) as FieldOptions;
  const takes: readonly string[] = TYPE_INFO[field.type]?.options ?? [];
  for (const k of ["max", "shape"] as const) {
    if (opts[k] !== undefined && !takes.includes(k)) return `options.${k} does not apply to ${field.type} fields`;
  }
  if (opts.max !== undefined && (!Number.isInteger(opts.max) || opts.max < 1 || opts.max > RATING.maxMax)) {
    return `options.max must be a whole number from 1 to ${RATING.maxMax}`;
  }
  if (opts.shape !== undefined) {
    const problem = shapeProblem(opts.shape);
    if (problem) return problem;
  }
  if (field.type === "percent" || field.type === "duration") {
    const v = (field.validation ?? {}) as Record<string, unknown>;
    const limit = field.type === "percent" ? PERCENT.limit : DURATION_MAX;
    const low = field.type === "percent" ? -PERCENT.limit : 0;
    for (const k of ["min", "max"] as const) {
      if (typeof v[k] === "number" && ((v[k] as number) < low || (v[k] as number) > limit)) return `validation.${k} must be between ${low} and ${limit}`;
    }
  }
  if (defaultValue !== undefined && defaultValue !== null) {
    try {
      normalizeInput(field, defaultValue);
    } catch (e) {
      if (e instanceof FieldValueError) return `default ${e.message}`;
      throw e;
    }
  }
  return null;
}

/**
 * Validates and normalizes one input value for a field. Returns the API-level value
 * (currency in major units). `null` clears a field; callers enforce `required`.
 */
export function normalizeInput(field: FieldLike, value: unknown): unknown {
  const fail = (msg: string): never => {
    throw new FieldValueError(field.api_name, msg);
  };
  if (value === null) return null;
  // Postgres text and jsonb can't hold U+0000; refused here, every string type at once, rather than failing the write with a 500.
  if (typeof value === "string" ? value.includes("\0") : Array.isArray(value) && value.some((x) => typeof x === "string" && x.includes("\0"))) {
    fail("must not contain NUL (\\u0000) characters");
  }
  const v = field.validation ?? {};
  switch (field.type) {
    case "text":
    case "long_text": {
      if (typeof value !== "string") fail("must be a string");
      const s = value as string;
      const max = Math.min(v.max_length ?? Infinity, TEXT_MAX[field.type]);
      if (s.length > max) fail(`must be at most ${max} characters`);
      if (v.pattern) {
        const re = storedPattern(field, v.pattern);
        if (re.programSize() * s.length > PATTERN_BUDGET) fail("is too long to check against the field's format rule");
        if (!re.test(s)) fail("does not match the required format");
      }
      return s;
    }
    case "number":
    case "currency": {
      const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isFinite(n)) fail("must be a number");
      const num = n as number;
      if (v.min !== undefined && num < v.min) fail(`must be at least ${v.min}`);
      if (v.max !== undefined && num > v.max) fail(`must be at most ${v.max}`);
      if (field.type === "currency" && Math.abs(num) > 9e13) fail("is too large");
      if (Math.abs(num) > MAX_NUMBER) fail(`must be between -${MAX_NUMBER} and ${MAX_NUMBER}`);
      return field.type === "currency" ? Math.round(num * 100) / 100 : num;
    }
    case "boolean":
      if (typeof value !== "boolean") fail("must be true or false");
      return value;
    case "date": {
      // The round trip rejects dates JavaScript rolls over (2024-02-31) but Postgres refuses.
      // Year 0000 too: JavaScript takes it, Postgres has no year 0.
      if (typeof value !== "string" || !DATE.test(value) || value.startsWith("0000") || Number.isNaN(Date.parse(value))
        || new Date(value).toISOString().slice(0, 10) !== value) fail("must be a date (YYYY-MM-DD) from year 0001 to 9999");
      return value;
    }
    case "datetime": {
      if (typeof value !== "string" || value.length > 100 || Number.isNaN(Date.parse(value))) fail("must be an ISO 8601 date-time");
      const iso = new Date(value as string).toISOString();
      if (!/^\d{4}-/.test(iso) || iso.startsWith("0000")) fail("must be a date-time between years 0001 and 9999");
      return iso;
    }
    case "email": {
      if (typeof value !== "string" || !EMAIL.test(value.trim()) || value.length > 320) fail("must be a valid email address");
      return (value as string).trim().toLowerCase();
    }
    case "phone":
      if (typeof value !== "string" || !PHONE.test(value.trim())) fail("must be a phone number");
      return (value as string).trim();
    case "url": {
      if (typeof value !== "string") fail("must be a URL");
      try {
        const u = new URL(value as string);
        if (u.protocol !== "https:" && u.protocol !== "http:") fail("must be an http(s) URL");
      } catch {
        fail("must be a URL");
      }
      return value;
    }
    case "single_select":
    case "status": {
      if (typeof value !== "string") fail("must be one of the allowed values");
      const allowed = field.options.values;
      if (allowed && !allowed.some((a) => a.key === value)) {
        fail(`must be one of: ${allowed.map((a) => a.key).join(", ")}`);
      }
      return value;
    }
    case "multi_select": {
      if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) fail("must be an array of values");
      const allowed = field.options.values;
      const bad = allowed ? (value as string[]).filter((x) => !allowed.some((a) => a.key === x)) : [];
      if (bad.length) fail(`contains values that are not allowed: ${bad.join(", ")}`);
      return [...new Set(value as string[])];
    }
    case "address":
      return normalizeAddress(fail, value);
    case "json":
      return normalizeJson(fail, field, value);
    case "rating": {
      const n = typeof value === "string" && /^\s*\d{1,3}\s*$/.test(value) ? Number(value) : value;
      const max = ratingMax(field);
      if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > max) fail(`must be a whole number from 1 to ${max}`);
      return n;
    }
    case "percent": {
      const n = parsePercent(value);
      if (n === null) fail('must be a percentage: a number such as 12.5, or text such as "12.5%"');
      const min = v.min ?? PERCENT.defaultMin;
      const max = v.max ?? PERCENT.defaultMax;
      if (n! < min || n! > max) fail(`must be between ${min} and ${max} (percent)`);
      // Kept to 4 decimals: more is refused rather than rounded away (0.00001 would silently become 0).
      if ((plainDecimal(n!).split(".")[1] ?? "").length > PERCENT.decimals) fail(`takes at most ${PERCENT.decimals} decimal places`);
      return n!;
    }
    case "duration": {
      const n = parseDuration(value);
      if (typeof n === "string") fail(n);
      if ((n as number) < 0 || (n as number) > DURATION_MAX) fail(`must be from 0 to ${DURATION_MAX} seconds`);
      if (v.min !== undefined && (n as number) < v.min) fail(`must be at least ${v.min} seconds`);
      if (v.max !== undefined && (n as number) > v.max) fail(`must be at most ${v.max} seconds`);
      return n;
    }
    case "relation": {
      if (field.options.cardinality === "many_to_many") {
        if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) fail("must be an array of record IDs");
        return [...new Set(value as string[])];
      }
      if (typeof value !== "string") fail("must be a record ID");
      return value;
    }
  }
}

/** Converts a normalized API value to its stored form (currency becomes integer minor units). */
export function toStorage(type: FieldType, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (type === "currency") return Math.round((value as number) * 100);
  return value;
}

/** An address as responses carry it: every part (null when empty) and `display`. */
function addressOut(raw: unknown): Record<string, string | null> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const out: Record<string, string | null> = {};
  for (const p of ADDRESS_PART_NAMES) out[p] = typeof a[p] === "string" ? (a[p] as string) : null;
  out.display = formatAddress(out);
  return out;
}

/** Converts a stored value back to its API form. */
export function fromStorage(type: FieldType, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  switch (type) {
    case "currency":
      return Number(raw) / 100;
    case "number": case "rating": case "percent": case "duration":
      return Number(raw);
    case "address":
      return addressOut(raw);
    case "date":
      return raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw).slice(0, 10);
    case "datetime":
      return raw instanceof Date ? raw.toISOString() : new Date(String(raw)).toISOString();
    default:
      return raw;
  }
}
