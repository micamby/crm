import { decodeId } from "../lib/ids.js";
import { forbidden, unprocessable } from "../lib/errors.js";
import type { AccessGuard } from "./access.js";
import { ENTITIES, isEntity, own, type FieldType } from "./catalog.js";
import {
  ADDRESS_PART_NAMES, JSON_PATH, jsonNumberProblem, MAX_NUMBER, parseDuration, parsePercent, TYPE_INFO, type FilterOp,
} from "./fieldtypes.js";
import { getObject, quoteIdent, type FieldMeta, type ObjectMeta, type Schema } from "./schema.js";

/**
 * The query language: a JSON filter tree compiled to parameterized SQL. Field names are
 * resolved through metadata, every value is a bound parameter, and there is no raw SQL.
 */
export type Op = FilterOp;

export interface Predicate { field?: string; path?: string[]; op: Op; value?: unknown }
export type Where = Predicate | { and: Where[] } | { or: Where[] } | { not: Where };

export interface QueryInput {
  object: string;
  where?: Where;
  sort?: { field: string; dir?: "asc" | "desc" }[];
  limit?: number;
  cursor?: string;
  include_archived?: boolean;
  /** Also count the matching records, up to COUNT_CAP. */
  count?: boolean;
  /** Only archived records (to find one to restore). Wins over include_archived. */
  archived_only?: boolean;
}

export const LIMITS = {
  maxPredicates: 20, maxDepth: 2, maxPageSize: 200, defaultPageSize: 50,
  /** and/or/not nesting, and every node of the tree: hostile trees get a 422, not a stack overflow. */
  maxNesting: 8, maxNodes: 100, maxListValues: 500, minContains: 3, maxTextValue: 2_000,
} as const;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

interface Target {
  table: string;
  objectId: string | null; // set for custom objects (rows live in `records`)
  fields: Map<string, ScalarField>;
  name: string;
}

interface ScalarField {
  api_name: string;
  type: FieldType;
  column: string | null;       // typed column, or null for JSON-stored custom fields
  jsonColumn: string | null;   // custom | data
  storageKey: string | null;
  restricted: boolean;
  relationTo: string | null;   // for relation fields
  linkFieldId: string | null;  // custom relations are stored in record_links
  /** A part of an address (hq.city) or a path into a json value (meta.a.b): the field it belongs to, whose access and sensitivity it has. */
  parent?: string;
  part?: string;
  jsonPath?: string[];
}

const BUILTIN: ScalarField[] = [
  { api_name: "id", type: "relation", column: "id", jsonColumn: null, storageKey: null, restricted: false, relationTo: "__self", linkFieldId: null },
  { api_name: "created_at", type: "datetime", column: "created_at", jsonColumn: null, storageKey: null, restricted: false, relationTo: null, linkFieldId: null },
  { api_name: "updated_at", type: "datetime", column: "updated_at", jsonColumn: null, storageKey: null, restricted: false, relationTo: null, linkFieldId: null },
];

const ENTITY_FIELDS: Record<string, { api_name: string; type: FieldType; column: string }[]> = {
  user: [{ api_name: "name", type: "text", column: "name" }, { api_name: "email", type: "email", column: "email" }],
  pipeline: [{ api_name: "name", type: "text", column: "name" }],
  stage: [{ api_name: "name", type: "text", column: "name" }, { api_name: "category", type: "text", column: "category" }],
};

function scalar(obj: ObjectMeta, f: FieldMeta): ScalarField {
  const jsonColumn = f.column_name ? null : obj.is_system ? "custom" : "data";
  return {
    api_name: f.api_name, type: f.type, column: f.column_name, jsonColumn, storageKey: f.column_name ? null : f.storage_key,
    restricted: f.sensitivity === "restricted", relationTo: f.type === "relation" ? f.options.to ?? null : null,
    linkFieldId: f.type === "relation" && !f.column_name ? f.id : null,
  };
}

export function targetFor(schema: Schema, name: string): Target {
  if (isEntity(name)) {
    const fields = new Map<string, ScalarField>();
    for (const f of [...BUILTIN.filter((b) => b.api_name === "id"), ...own(ENTITY_FIELDS, name)!.map((e) => ({
      api_name: e.api_name, type: e.type, column: e.column, jsonColumn: null, storageKey: null, restricted: false, relationTo: null, linkFieldId: null,
    }))]) fields.set(f.api_name, f);
    return { table: ENTITIES[name].table, objectId: null, fields, name };
  }
  const obj = getObject(schema, name);
  const fields = new Map<string, ScalarField>(BUILTIN.map((b) => [b.api_name, b]));
  for (const f of obj.fields) {
    const sf = scalar(obj, f);
    fields.set(f.api_name, sf);
    // An address's parts are text fields of their own for filters, sorts and groupings: hq.city, hq.country.
    if (f.type === "address") for (const part of ADDRESS_PART_NAMES) fields.set(`${f.api_name}.${part}`, { ...sf, api_name: `${f.api_name}.${part}`, type: "text", parent: f.api_name, part });
  }
  return { table: obj.table_name ?? "records", objectId: obj.is_system ? null : obj.id, fields, name: obj.api_name };
}

const CASTS = Object.fromEntries(Object.entries(TYPE_INFO).map(([t, info]) => [t, info.cast])) as Record<FieldType, string>;

/**
 * A path into a json field, written field.key.key (array indexes too: field.items.0), as a filter field.
 * Only eq, neq and is_null, with a scalar value, compared as JSON: no index, but each value is at most 16 KB.
 */
function jsonPathField(t: Target, name: string): ScalarField | undefined {
  const dot = name.indexOf(".");
  if (dot < 1) return undefined;
  const parent = t.fields.get(name.slice(0, dot));
  if (!parent || parent.type !== "json" || parent.parent) return undefined;
  const path = name.slice(dot + 1).split(".");
  if (path.length > JSON_PATH.maxKeys || path.some((k) => !JSON_PATH.key.test(k))) {
    throw unprocessable(`"${name.slice(0, 200)}": a json path is 1 to ${JSON_PATH.maxKeys} keys of letters, digits, _ and -, joined with dots`);
  }
  return { ...parent, api_name: name, parent: parent.api_name, jsonPath: path };
}

/** True when JavaScript reads YYYY-MM-DD as that same day, not a rolled-over one. */
const sameDay = (day: string) => {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day;
};

const OPS: Op[] = ["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "contains", "starts_with", "is_null"];

export class Compiler {
  readonly params: unknown[] = [];
  private aliasN = 0;
  private predicates = 0;
  private nodes = 0;

  /** `guard` limits filters to objects and fields the caller can read; internal callers (alerts, automations) pass none. */
  constructor(private readonly schema: Schema, private readonly guard?: AccessGuard) {}

  param(value: unknown, cast?: string): string {
    this.params.push(value);
    return `$${this.params.length}${cast ? `::${cast}` : ""}`;
  }

  alias(): string {
    return `t${this.aliasN++}`;
  }

  /** SQL expression for a scalar field on alias `a`. */
  expr(a: string, f: ScalarField): string {
    if (f.column) return `${a}.${quoteIdent(f.column)}`;
    if (!f.jsonColumn || !f.storageKey || !/^f_[0-9a-f]{10}$/.test(f.storageKey)) throw new Error("bad field storage");
    if (f.part !== undefined) {
      if (!(ADDRESS_PART_NAMES as string[]).includes(f.part)) throw new Error("bad address part");
      return `(${a}.${f.jsonColumn}->'${f.storageKey}'->>'${f.part}')`;
    }
    if (f.jsonPath) return `(${a}.${f.jsonColumn}->'${f.storageKey}' #> ${this.param(f.jsonPath, "text[]")})`;
    if (f.type === "multi_select" || CASTS[f.type] === "jsonb") return `(${a}.${f.jsonColumn}->'${f.storageKey}')`;
    const text = `(${a}.${f.jsonColumn}->>'${f.storageKey}')`;
    const cast = CASTS[f.type];
    // Year 0000 passed the write checks before they asked for year 1 or later, and Postgres has no year 0: such a
    // stored value reads as empty rather than failing every list, sort and aggregate that touches the field.
    if (cast === "date" || cast === "timestamptz") return `(CASE WHEN left(${text}, 4) = '0000' THEN NULL ELSE ${text}::${cast} END)`;
    return cast === "text" ? text : `(${text})::${cast}`;
  }

  compileWhere(t: Target, a: string, w: Where, depth: number, nesting = 0): string {
    if (!isPlainObject(w)) throw unprocessable("A filter must be an object: a condition, or {and: [...]}, {or: [...]} or {not: ...}");
    if (++this.nodes > LIMITS.maxNodes) throw unprocessable(`A filter can have at most ${LIMITS.maxNodes} parts`);
    const has = (k: string) => Object.hasOwn(w, k);
    if (has("and") || has("or") || has("not")) {
      if (nesting >= LIMITS.maxNesting) throw unprocessable(`and/or/not can be nested at most ${LIMITS.maxNesting} deep`);
      if ([has("and"), has("or"), has("not"), has("field"), has("path")].filter(Boolean).length > 1) {
        throw unprocessable("Each part of a filter is one of: a condition, {and: [...]}, {or: [...]} or {not: ...}");
      }
      if (has("not")) return `(NOT ${this.compileWhere(t, a, (w as { not: Where }).not, depth, nesting + 1)})`;
      const list = has("and") ? (w as { and: Where[] }).and : (w as { or: Where[] }).or;
      if (!Array.isArray(list) || list.length === 0) throw unprocessable("and/or need a non-empty list");
      if (list.length > LIMITS.maxNodes) throw unprocessable(`A filter can have at most ${LIMITS.maxNodes} parts`);
      return `(${list.map((x) => this.compileWhere(t, a, x, depth, nesting + 1)).join(has("and") ? " AND " : " OR ")})`;
    }
    if (++this.predicates > LIMITS.maxPredicates) throw unprocessable(`A query can have at most ${LIMITS.maxPredicates} conditions`);
    const p = w as unknown as Predicate;
    if (p.field !== undefined && typeof p.field !== "string") throw unprocessable("A condition's field must be a field name");
    if (p.path !== undefined && (!Array.isArray(p.path) || p.path.some((x) => typeof x !== "string"))) {
      throw unprocessable("A condition's path must be a list of field names");
    }
    const path = p.path ?? (p.field ? [p.field] : []);
    if (path.length === 0) throw unprocessable("Each condition needs a field or a path");
    if (path.length > LIMITS.maxDepth + 1) throw unprocessable(`Paths can follow at most ${LIMITS.maxDepth} relations`);
    if (typeof p.op !== "string") throw unprocessable(`Each condition needs an op: one of ${OPS.join(", ")}`);
    return this.compilePath(t, a, path, p, depth);
  }

  private compilePath(t: Target, a: string, path: string[], p: Predicate, depth: number): string {
    const [head, ...rest] = path as [string, ...string[]];
    const f = t.fields.get(head) ?? jsonPathField(t, head);
    if (!f) throw unprocessable(`"${head}" is not a field of ${t.name}`, { field: head, available: [...t.fields.keys()].filter((k) => !k.includes(".")) });
    if (f.restricted) throw unprocessable(`"${head}" is restricted and cannot be filtered on`);
    // A filter on a field the caller can't see would let them infer its values; a part or path is its field's.
    if (this.guard && !this.guard.field(t.name, f.parent ?? head)) throw forbidden(`"${head}" is not visible to this key, so it cannot be filtered on`);
    if (rest.length === 0) return this.compilePredicate(t, a, f, p);
    // filter[hq.city] arrives as the path ["hq", "city"]: a part of an address, or a path into json, not a relation hop.
    if ((f.type === "address" || f.type === "json") && !f.parent) return this.compilePath(t, a, [`${head}.${rest.join(".")}`], p, depth);
    if (!f.relationTo || f.relationTo === "__self") throw unprocessable(`"${head}" is not a relation, so the path cannot continue`);
    if (depth >= LIMITS.maxDepth) throw unprocessable(`Paths can follow at most ${LIMITS.maxDepth} relations`);
    if (this.guard && !this.guard.object(f.relationTo)) throw forbidden(`"${head}" leads to ${f.relationTo} records, which this key can't read`);
    const target = targetFor(this.schema, f.relationTo);
    const b = this.alias();
    const inner = this.compilePath(target, b, rest, p, depth + 1);
    const objFilter = target.objectId ? ` AND ${b}.object_id = ${this.param(target.objectId, "uuid")}` : "";
    if (f.linkFieldId) {
      return `EXISTS (SELECT 1 FROM record_links l${b} JOIN ${quoteIdent(target.table)} ${b} ON ${b}.tenant_id = l${b}.tenant_id AND ${b}.id = l${b}.to_id
        WHERE l${b}.field_id = ${this.param(f.linkFieldId, "uuid")} AND l${b}.from_id = ${a}.id${objFilter} AND ${inner})`;
    }
    return `${this.expr(a, f)} IN (SELECT ${b}.id FROM ${quoteIdent(target.table)} ${b} WHERE ${inner}${objFilter})`;
  }

  /** field.key.key eq / neq / is_null: the value at that path, compared as JSON. A missing key and a JSON null are both empty. */
  private jsonPathPredicate(a: string, f: ScalarField, p: Predicate): string {
    const e = this.expr(a, f);
    if (p.op === "is_null") return p.value !== false ? `(${e} IS NULL OR ${e} = 'null'::jsonb)` : `(${e} IS NOT NULL AND ${e} <> 'null'::jsonb)`;
    // Sent as JSON text and cast in SQL: a jsonb parameter would be JSON-encoded a second time by the driver.
    if (p.op === "eq") return `${e} = ${this.param(jsonScalar(f, p.value, URL_PREDICATES.has(p)), "text")}::jsonb`;
    if (p.op === "neq") return `${e} IS DISTINCT FROM ${this.param(jsonScalar(f, p.value, URL_PREDICATES.has(p)), "text")}::jsonb`;
    throw unprocessable(`A path into json ("${f.api_name.slice(0, 200)}") supports eq, neq and is_null`);
  }

  private relationValue(f: ScalarField, t: Target, v: unknown): string {
    if (typeof v !== "string") throw unprocessable(`"${f.api_name}" takes record IDs`);
    const decoded = decodeId(v);
    const expected = f.relationTo === "__self" ? this.prefixOf(t.name) : this.prefixOf(f.relationTo!);
    if (!decoded || decoded.prefix !== expected) throw unprocessable(`"${v}" is not a valid ${f.relationTo === "__self" ? t.name : f.relationTo} ID`);
    return decoded.uuid;
  }

  prefixOf(name: string): string {
    if (isEntity(name)) return ENTITIES[name].prefix;
    return getObject(this.schema, name).id_prefix;
  }

  /** Converts a filter value to the field's type here, so a bad value is a 422 rather than a Postgres cast error. */
  private convert(f: ScalarField, t: Target, v: unknown): unknown {
    if (v === null) throw unprocessable(`Use the is_null operator to match empty values of "${f.api_name}"`);
    if (f.type === "relation") return this.relationValue(f, t, v);
    // Numbers and booleans are also taken as text, typed by the field: values from a URL (filter[amount][gt]=100)
    // or the CLI arrive as text, and only the field knows that 02139 is a postcode, not a number.
    if (f.type === "currency" || f.type === "number" || f.type === "rating") {
      const n = typeof v === "string" && /^-?\d{1,16}(\.\d{1,16})?$/.test(v) ? Number(v) : v;
      if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > MAX_NUMBER) throw unprocessable(`"${f.api_name}" takes a number`);
      return f.type === "currency" ? Math.round(n * 100) : n;
    }
    // A percent filter takes "12.5%" as well, and a duration filter an ISO 8601 duration, as their fields do.
    if (f.type === "percent") {
      const n = parsePercent(v);
      if (n === null || Math.abs(n) > MAX_NUMBER) throw unprocessable(`"${f.api_name}" takes a percentage such as 12.5`);
      return n;
    }
    if (f.type === "duration") {
      const n = parseDuration(v);
      if (typeof n === "string" || Math.abs(n) > MAX_NUMBER) throw unprocessable(`"${f.api_name}" takes a number of seconds or an ISO 8601 duration such as PT1H30M`);
      return n;
    }
    if (f.part === "country" && typeof v === "string") return v.trim().toUpperCase();
    if (f.type === "boolean") {
      if (v === "true" || v === "false") return v === "true";
      if (typeof v !== "boolean") throw unprocessable(`"${f.api_name}" takes true or false`);
    }
    if (f.type === "date" || f.type === "datetime") {
      const str = typeof v === "string" && v.length <= 100 ? v : "";
      const ms = Date.parse(str);
      const day = /^\d{4}-\d{2}-\d{2}/.test(str) ? str.slice(0, 10) : null;
      // Rejects what Postgres would refuse: years past 9999, and days JavaScript rolls over (2024-02-31).
      if (Number.isNaN(ms) || !/^\d{4}-/.test(new Date(ms).toISOString()) || (day && !sameDay(day))) {
        throw unprocessable(`"${f.api_name}" takes an ISO date`);
      }
      return f.type === "date" ? day ?? new Date(ms).toISOString().slice(0, 10) : new Date(ms).toISOString();
    }
    if (typeof v === "object") throw unprocessable(`"${f.api_name}" takes a single value`);
    if (typeof v === "string" && v.length > LIMITS.maxTextValue) throw unprocessable(`Filter values can be at most ${LIMITS.maxTextValue} characters`);
    return v;
  }

  private compilePredicate(t: Target, a: string, f: ScalarField, p: Predicate): string {
    const cast = CASTS[f.type];
    if (f.jsonPath) return this.jsonPathPredicate(a, f, p);
    // What each type supports is declared in core/fieldtypes.ts (TYPE_INFO); the checks below are what the SQL needs.
    if (OPS.includes(p.op) && !TYPE_INFO[f.type].ops.includes(p.op)) {
      const hint = f.type === "address" ? `; filter by its parts: ${ADDRESS_PART_NAMES.map((x) => `${f.api_name}.${x}`).join(", ")}`
        : f.type === "json" ? `; filter on a key inside it with ${f.api_name}.key (eq, neq, is_null)` : "";
      throw unprocessable(`"${f.api_name}" (${f.type}) supports ${TYPE_INFO[f.type].ops.join(", ")}, not ${p.op}${hint}`);
    }
    if (p.op === "is_null") {
      const want = p.value !== false;
      if (f.linkFieldId) {
        const ex = `EXISTS (SELECT 1 FROM record_links lk WHERE lk.field_id = ${this.param(f.linkFieldId, "uuid")} AND lk.from_id = ${a}.id)`;
        return want ? `(NOT ${ex})` : ex;
      }
      const e = this.expr(a, f);
      return want ? `${e} IS NULL` : `${e} IS NOT NULL`;
    }
    const many = p.op === "in" || p.op === "not_in";
    if (many && (!Array.isArray(p.value) || p.value.length === 0 || p.value.length > LIMITS.maxListValues)) {
      throw unprocessable(`"${p.op}" takes a list of 1 to ${LIMITS.maxListValues} values`);
    }
    if (f.linkFieldId) {
      if (!["eq", "in", "neq", "not_in"].includes(p.op)) throw unprocessable(`Relation "${f.api_name}" supports eq, in, neq, not_in and is_null`);
      const ids = (many ? (p.value as unknown[]) : [p.value]).map((v) => this.convert(f, t, v));
      const ex = `EXISTS (SELECT 1 FROM record_links lk WHERE lk.field_id = ${this.param(f.linkFieldId, "uuid")} AND lk.from_id = ${a}.id AND lk.to_id = ANY(${this.param(ids, "uuid[]")}))`;
      return p.op === "eq" || p.op === "in" ? ex : `(NOT ${ex})`;
    }
    if (f.type === "multi_select" && p.op !== "contains") throw unprocessable(`"${f.api_name}" supports contains and is_null`);
    const e = this.expr(a, f);
    switch (p.op) {
      case "eq":
        return `${e} = ${this.param(this.convert(f, t, p.value), cast)}`;
      case "neq":
        return `${e} IS DISTINCT FROM ${this.param(this.convert(f, t, p.value), cast)}`;
      case "in":
      case "not_in": {
        // Booleans go as text and are cast in SQL: the driver can't send a boolean[] parameter.
        const values = (p.value as unknown[]).map((v) => this.convert(f, t, v)).map((v) => (typeof v === "boolean" ? String(v) : v));
        const sql = `${e} = ANY(${this.param(values, `${cast}[]`)})`;
        return p.op === "in" ? sql : `(${e} IS NULL OR NOT ${sql})`;
      }
      case "gt": case "gte": case "lt": case "lte": {
        if (!["numeric", "date", "timestamptz"].includes(cast)) throw unprocessable(`"${p.op}" only applies to numbers and dates`);
        const sym = ({ gt: ">", gte: ">=", lt: "<", lte: "<=" } as const)[p.op];
        return `${e} ${sym} ${this.param(this.convert(f, t, p.value), cast)}`;
      }
      case "contains": {
        if (f.type === "multi_select") {
          if (typeof p.value !== "string") throw unprocessable(`"contains" on "${f.api_name}" takes one value`);
          return `${e} ? ${this.param(p.value, "text")}`;
        }
        if (cast !== "text" || f.type === "single_select" || f.type === "status") throw unprocessable(`"contains" only applies to text fields`);
        // An unindexed scan of JSON text: require a term long enough to be selective.
        if (typeof p.value !== "string" || p.value.trim().length < LIMITS.minContains || p.value.length > LIMITS.maxTextValue) {
          throw unprocessable(`"contains" takes text of ${LIMITS.minContains} to ${LIMITS.maxTextValue} characters`);
        }
        return `${e} ILIKE ${this.param(`%${escapeLike(p.value)}%`, "text")}`;
      }
      case "starts_with": {
        if (cast !== "text") throw unprocessable(`"starts_with" only applies to text fields`);
        if (typeof p.value !== "string" || p.value.length > LIMITS.maxTextValue) throw unprocessable(`"starts_with" takes text of at most ${LIMITS.maxTextValue} characters`);
        return `${e} ILIKE ${this.param(`${escapeLike(p.value)}%`, "text")}`;
      }
      default:
        throw unprocessable(`Unknown operator "${String(p.op).slice(0, 50)}". Use one of: ${OPS.join(", ")}`);
    }
  }
}

export const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** A scalar a json path is compared with: text, a number or true/false, as JSON. Values from a URL arrive as text and stay text. */
function jsonScalar(f: ScalarField, v: unknown, fromUrl: boolean): string {
  // A URL carries only text: there 1, true, false and null mean the JSON scalar, as the same filter in a body would say it.
  if (fromUrl && typeof v === "string" && /^(?:true|false|null|-?(?:0|[1-9]\d{0,15})(?:\.\d{1,16})?)$/.test(v)) v = JSON.parse(v);
  if (v === null && fromUrl) return "null";
  if (typeof v === "string" ? v.length > LIMITS.maxTextValue || v.includes("\0") : !(typeof v === "boolean" || (typeof v === "number" && !jsonNumberProblem(v)))) {
    throw unprocessable(`"${f.api_name}" takes text (at most ${LIMITS.maxTextValue} characters), a number (within ±${MAX_NUMBER}) or true/false`);
  }
  return JSON.stringify(v);
}

/**
 * Conditions built from URL query parameters (filter[field]=value): their values are text whatever was meant.
 * Kept apart from the predicate itself, so a body can't claim it.
 */
export const URL_PREDICATES = new WeakSet<Predicate>();

export interface CompiledQuery {
  text: string; params: unknown[]; limit: number; sortType: FieldType;
  /** The sort as the cursor records it: a cursor is accepted back only for the same sort. */
  sortKey: string; sortCount: number;
  /** count(*) under the same filter (no cursor), stopped at COUNT_CAP + 1 rows so its cost is bounded. */
  countText: string; countParams: unknown[];
}

/** Counts stop here: exact below it, "at least this many" above it. */
export const COUNT_CAP = 10_000;
/** Sort keys a list can have, before the ID tiebreak. */
export const MAX_SORTS = 3;
/**
 * Text sorts by its first SORT_TEXT_CHARS characters, ties broken by ID: the cursor carries each sort value,
 * so a record holding 2,000 multibyte characters would otherwise make a cursor too long for a URL, and stop
 * every reader paging or exporting past it under that sort.
 */
export const SORT_TEXT_CHARS = 200;
/** Longest numeric text Postgres prints for a number stored as JSON: a double's 309 digits, or 17 after 307 zeros. */
const MAX_NUMERIC_TEXT = 400;
/**
 * Longest cursor a valid sort produces, so none that the server handed out is refused: per key, its text at up
 * to 6 bytes a character (JSON's \u escape) or a number's text; each key's name, the ID and the JSON around them;
 * base64 adds a third.
 */
export const MAX_CURSOR = Math.ceil((MAX_SORTS * (Math.max(SORT_TEXT_CHARS * 6, MAX_NUMERIC_TEXT) + 3 + 80) + 100) * 4 / 3);

export interface SortInput { field: string; dir?: "asc" | "desc" }
interface SortKey { field: string; dir: "asc" | "desc"; expr: string; type: FieldType }

/** The sort fields a query may use: readable, not restricted, and with an order Postgres can compare. */
function sortKeys(t: Target, c: Compiler, a: string, sorts: SortInput[], guard?: AccessGuard): SortKey[] {
  if (!Array.isArray(sorts) || sorts.length === 0) throw unprocessable("sort needs at least one field");
  if (sorts.length > MAX_SORTS) throw unprocessable(`Sort by at most ${MAX_SORTS} fields (ties are broken by ID)`);
  const seen = new Set<string>();
  return sorts.map((s) => {
    if (!isPlainObject(s) || typeof s.field !== "string") throw unprocessable("Each sort is {field, dir}");
    if (s.dir !== undefined && s.dir !== "asc" && s.dir !== "desc") throw unprocessable('A sort\'s dir is "asc" or "desc"');
    if (seen.has(s.field)) throw unprocessable(`"${s.field}" appears twice in the sort`);
    seen.add(s.field);
    const sf = t.fields.get(s.field);
    if (!sf) throw unprocessable(`Cannot sort by "${s.field}": not a field of ${t.name}`);
    // Sort order reveals values just as a filter does; a part's order reveals its field's.
    if (guard && !guard.field(t.name, sf.parent ?? s.field)) throw forbidden(`Cannot sort by "${s.field}": it is not visible to this key`);
    if (sf.restricted || sf.linkFieldId || (!TYPE_INFO[sf.type].sort && sf.api_name !== "id")) {
      const why = sf.type === "long_text" ? " (long text)"
        : sf.type === "address" && !sf.restricted ? `; sort by its parts, e.g. ${s.field}.country,${s.field}.region,${s.field}.city` : "";
      throw unprocessable(`Cannot sort by "${s.field}"${why}`);
    }
    const e = c.expr(a, sf);
    return { field: s.field, dir: s.dir === "desc" ? "desc" : "asc", expr: CASTS[sf.type] === "text" ? `left(${e}, ${SORT_TEXT_CHARS})` : e, type: sf.type };
  });
}

/**
 * Rows after the cursor in ORDER BY (k1 IS NULL), k1, …, id: for each key i, rows equal to the cursor on
 * every earlier key and after it on key i (nulls come last); then rows equal on every key with a larger ID.
 */
function afterCursor(c: Compiler, a: string, keys: SortKey[], cur: CursorV2): string {
  // Sent as text and cast in SQL: the driver would turn a timestamptz parameter into a JavaScript Date, losing microseconds.
  const val = (k: SortKey, v: string) => `${c.param(v, "text")}::${CASTS[k.type]}`;
  const eq = (k: SortKey, v: string | null) => (v === null ? `${k.expr} IS NULL` : `${k.expr} = ${val(k, v)}`);
  const terms: string[] = [];
  keys.forEach((k, i) => {
    const v = cur.k[i]!;
    if (v === null) return; // after NULL on this key come only rows that tie on it
    const prefix = keys.slice(0, i).map((p, j) => eq(p, cur.k[j]!));
    terms.push(`(${[...prefix, `(${k.expr} ${k.dir === "desc" ? "<" : ">"} ${val(k, v)} OR ${k.expr} IS NULL)`].join(" AND ")})`);
  });
  terms.push(`(${[...keys.map((k, j) => eq(k, cur.k[j]!)), `${a}.id > ${c.param(cur.id, "uuid")}`].join(" AND ")})`);
  return `(${terms.join(" OR ")})`;
}

/** Compiles a full list query, with keyset pagination on (sort values…, id). */
export function compileQuery(schema: Schema, q: QueryInput, guard?: AccessGuard): CompiledQuery {
  const t = targetFor(schema, q.object);
  if (isEntity(q.object)) throw unprocessable(`"${q.object}" is not an object`);
  const c = new Compiler(schema, guard);
  const a = "r";
  const conds: string[] = [];
  if (t.objectId) conds.push(`${a}.object_id = ${c.param(t.objectId, "uuid")}`);
  if (q.archived_only) conds.push(`${a}.archived_at IS NOT NULL`);
  else if (!q.include_archived) conds.push(`${a}.archived_at IS NULL`);
  if (q.where) conds.push(c.compileWhere(t, a, q.where, 0));
  const from = `FROM ${quoteIdent(t.table)} ${a}`;
  const countParams = [...c.params];
  const countText = `SELECT count(*)::int AS n FROM (SELECT 1 ${from} ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""} LIMIT ${COUNT_CAP + 1}) s`;

  const keys = sortKeys(t, c, a, q.sort ?? [{ field: "created_at", dir: "desc" }], guard);
  const sortKey = keys.map((k) => `${k.field}:${k.dir}`).join(",");
  if (q.limit !== undefined && !Number.isInteger(q.limit)) throw unprocessable("limit must be a whole number");
  const limit = Math.min(Math.max(1, q.limit ?? LIMITS.defaultPageSize), LIMITS.maxPageSize);
  if (q.cursor) conds.push(afterCursor(c, a, keys, decodeCursor(q.cursor, keys, sortKey)));
  // Sort values go into the cursor as Postgres text, which keeps full precision (microseconds, numerics) and casts back exactly.
  const text = `SELECT ${a}.*, ${keys.map((k, i) => `(${k.expr})::text AS __s${i}`).join(", ")} ${from}
    ${conds.length ? `WHERE ${conds.join(" AND ")}` : ""}
    ORDER BY ${keys.map((k) => `(${k.expr} IS NULL), ${k.expr} ${k.dir === "desc" ? "DESC" : "ASC"}`).join(", ")}, ${a}.id ASC
    LIMIT ${limit + 1}`;
  return { text, params: c.params, limit, sortType: keys[0]!.type, sortKey, sortCount: keys.length, countText, countParams };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Offsets may carry seconds: Postgres prints local mean time that way for old dates in some time zones.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?)?(Z|[+-]\d{2}(:?\d{2}(:?\d{2})?)?)?$/;
/** Numeric text as Postgres prints it (plain digits, however many), or a JavaScript number's (1e+300) from a v1 cursor. */
const NUMERIC = /^-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d{1,3})?$/;

/** v1 cursors (one sort key) were {v, n, id}. v2: {s: the sort, k: one value per key (null for NULL), id}. */
interface CursorV2 { s: string; k: (string | null)[]; id: string }

/**
 * A cursor value as text Postgres can cast to the sort field's type, or null when it doesn't fit the type.
 * Every value a stored record can sort by passes, however extreme; a value Postgres still refuses to cast
 * is a 422 (records.ts), never a 500.
 */
function cursorValue(v: unknown, type: FieldType): string | null {
  const cast = CASTS[type];
  if (cast === "numeric") return (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= MAX_NUMERIC_TEXT && NUMERIC.test(v)) ? String(v) : null;
  if (cast === "boolean") return typeof v === "boolean" || v === "true" || v === "false" ? String(v) : null;
  if (typeof v !== "string") return null;
  if (cast === "uuid") return UUID.test(v) ? v : null;
  if (cast === "date") return /^\d{4}-\d{2}-\d{2}/.test(v) && sameDay(v.slice(0, 10)) ? v.slice(0, 10) : null;
  if (cast === "timestamptz") return v.length <= 40 && TIMESTAMP.test(v) ? v : null;
  // A v1 cursor may hold a longer value; the sort compares only the first SORT_TEXT_CHARS characters.
  const chars = [...v];
  return chars.length <= SORT_TEXT_CHARS ? v : chars.slice(0, SORT_TEXT_CHARS).join("");
}

/** Cursors come back from clients, so every part is checked against the sort's fields and types before it reaches SQL. */
function decodeCursor(raw: string, keys: SortKey[], sortKey: string): CursorV2 {
  const bad = () => unprocessable("Invalid cursor; start again without one");
  if (typeof raw !== "string" || raw.length > MAX_CURSOR) throw bad();
  let cur: unknown;
  try {
    cur = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  if (!isPlainObject(cur) || typeof cur.id !== "string" || !UUID.test(cur.id)) throw bad();
  let values: unknown[];
  if (Object.hasOwn(cur, "k")) {
    if (!Array.isArray(cur.k) || cur.k.length !== keys.length) throw bad();
    if (cur.s !== sortKey) throw unprocessable("This cursor belongs to a different sort; start again without one");
    values = cur.k;
  } else {
    // A v1 cursor, from before multi-column sorting: one key, and no record of the sort it was made for.
    if (keys.length !== 1 || typeof cur.n !== "boolean") throw bad();
    values = [cur.n ? null : cur.v];
  }
  const k = values.map((v, i) => {
    if (v === null) return null;
    const text = cursorValue(v, keys[i]!.type);
    if (text === null) throw bad();
    return text;
  });
  return { s: sortKey, k, id: cur.id };
}

export function encodeCursor(row: Record<string, unknown> & { id: string }, compiled: Pick<CompiledQuery, "sortKey" | "sortCount">): string {
  const k = Array.from({ length: compiled.sortCount }, (_, i) => (row[`__s${i}`] ?? null) as string | null);
  const cur: CursorV2 = { s: compiled.sortKey, k, id: row.id };
  return Buffer.from(JSON.stringify(cur)).toString("base64url");
}
