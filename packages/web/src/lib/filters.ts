import type { Sort, Where } from "./api/types";

/**
 * The filter builder's model, its compilation to the API's `where`, and its compact URL form.
 *
 * A filter is a group (all of / any of) of conditions and nested groups. A condition is a field path
 * (one field, or a relation then a field of the related object: ["account", "industry"]), an operator
 * and a value. "empty" and "not_empty" are the API's is_null true and false.
 */

export type UiOp = "eq" | "neq" | "in" | "not_in" | "gt" | "gte" | "lt" | "lte" | "contains" | "starts_with" | "empty" | "not_empty";
export const UI_OPS: readonly UiOp[] = ["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "contains", "starts_with", "empty", "not_empty"];

export type Scalar = string | number | boolean;
export interface Condition { kind: "cond"; path: string[]; op: UiOp; value?: Scalar | Scalar[] }
export interface Group { kind: "group"; conj: "and" | "or"; children: FilterNode[] }
export type FilterNode = Condition | Group;

export const emptyGroup = (conj: "and" | "or" = "and"): Group => ({ kind: "group", conj, children: [] });

/** Operators that take no value. */
export const takesNoValue = (op: UiOp) => op === "empty" || op === "not_empty";
/** Operators that take a list of values. */
export const takesList = (op: UiOp) => op === "in" || op === "not_in";

/** True when a condition has what its operator needs (an incomplete one is left out of the query). */
export function isComplete(c: Condition): boolean {
  if (takesNoValue(c.op)) return true;
  if (takesList(c.op)) return Array.isArray(c.value) && c.value.length > 0;
  if (c.value === undefined || c.value === null || Array.isArray(c.value)) return false;
  return typeof c.value !== "string" || c.value.trim() !== "";
}

/** Fields filtered by a part of their value (an address's city): `field.part` in the API, not a relation hop. */
export type PartFields = ReadonlySet<string>;

function compileCond(c: Condition, parts?: PartFields): Where | undefined {
  if (!isComplete(c)) return undefined;
  const target = c.path.length === 1 ? { field: c.path[0]! } : c.path.length === 2 && parts?.has(c.path[0]!) ? { field: c.path.join(".") } : { path: c.path };
  if (c.op === "empty") return { ...target, op: "is_null", value: true };
  if (c.op === "not_empty") return { ...target, op: "is_null", value: false };
  return { ...target, op: c.op, value: c.value };
}

/** The API `where` for a filter, or undefined when nothing in it is complete. */
export function compileWhere(node: FilterNode | null | undefined, partFields?: PartFields): Where | undefined {
  if (!node) return undefined;
  if (node.kind === "cond") return compileCond(node, partFields);
  const parts = node.children.map((n) => compileWhere(n, partFields)).filter((w): w is Where => w !== undefined);
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return node.conj === "and" ? { and: parts } : { or: parts };
}

/** Joins two filters with AND (the board's pipeline condition and the user's filter, say). */
export function andWhere(...parts: (Where | undefined)[]): Where | undefined {
  const present = parts.filter((p): p is Where => p !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return { and: present };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The builder's model of an API `where` (a saved view's), or null when it uses something the builder can't show (`not`). */
export function fromWhere(w: unknown): Group | null {
  const node = nodeFromWhere(w, 0);
  if (!node) return null;
  return node.kind === "group" ? node : { kind: "group", conj: "and", children: [node] };
}

function nodeFromWhere(w: unknown, depth: number): FilterNode | null {
  if (!isObj(w) || depth > 6) return null;
  if (Array.isArray(w.and) || Array.isArray(w.or)) {
    const list = (w.and ?? w.or) as unknown[];
    const children: FilterNode[] = [];
    for (const x of list) {
      const n = nodeFromWhere(x, depth + 1);
      if (!n) return null;
      children.push(n);
    }
    return { kind: "group", conj: w.and ? "and" : "or", children };
  }
  if ("not" in w) return null;
  // "address.city" (a part of a field) reads back as the path [address, city].
  const path = Array.isArray(w.path) ? w.path : typeof w.field === "string" ? w.field.split(".") : null;
  if (!path || path.some((p) => typeof p !== "string") || typeof w.op !== "string") return null;
  if (w.op === "is_null") return { kind: "cond", path: path as string[], op: w.value === false ? "not_empty" : "empty" };
  if (!(UI_OPS as readonly string[]).includes(w.op)) return null;
  const value = w.value;
  const ok = (v: unknown): v is Scalar => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  if (!(ok(value) || (Array.isArray(value) && value.every(ok)))) return null;
  return { kind: "cond", path: path as string[], op: w.op as UiOp, value };
}

// --- URL form ------------------------------------------------------------------------------------
// Compact JSON: a group is {o: "and" | "or", c: [...]}, a condition is ["field.path", op, value?].
// URLs are untrusted input, so decoding checks every part and gives up (null) on anything odd.

type Packed = { o: "and" | "or"; c: (Packed | [string, UiOp] | [string, UiOp, Scalar | Scalar[]])[] };

export function packFilter(g: Group): Packed {
  return {
    o: g.conj,
    c: g.children.map((n) => (n.kind === "group" ? packFilter(n)
      : n.value === undefined || takesNoValue(n.op) ? [n.path.join("."), n.op] as [string, UiOp] : [n.path.join("."), n.op, n.value] as [string, UiOp, Scalar | Scalar[]])),
  };
}

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const LIMITS = { depth: 4, nodes: 40, values: 500, text: 2000 };

export function unpackFilter(raw: unknown): Group | null {
  let input = raw;
  if (typeof raw === "string") {
    if (raw.length > 20_000) return null;
    try {
      input = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const budget = { nodes: 0 };
  return unpackGroup(input, 0, budget);
}

function unpackGroup(v: unknown, depth: number, budget: { nodes: number }): Group | null {
  if (!isObj(v) || (v.o !== "and" && v.o !== "or") || !Array.isArray(v.c) || depth > LIMITS.depth) return null;
  const children: FilterNode[] = [];
  for (const x of v.c) {
    if (++budget.nodes > LIMITS.nodes) return null;
    const n = Array.isArray(x) ? unpackCond(x) : unpackGroup(x, depth + 1, budget);
    if (!n) return null;
    children.push(n);
  }
  return { kind: "group", conj: v.o, children };
}

const scalar = (v: unknown): v is Scalar =>
  (typeof v === "string" && v.length <= LIMITS.text) || (typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean";

function unpackCond(x: unknown[]): Condition | null {
  const [p, op, value] = x;
  if (typeof p !== "string" || typeof op !== "string" || !(UI_OPS as readonly string[]).includes(op) || x.length > 3) return null;
  const path = p.split(".");
  if (path.length > 3 || !path.every((s) => NAME.test(s))) return null;
  if (x.length === 2) return { kind: "cond", path, op: op as UiOp };
  if (scalar(value) || (Array.isArray(value) && value.length <= LIMITS.values && value.every(scalar))) {
    return { kind: "cond", path, op: op as UiOp, value };
  }
  return null;
}

export const encodeFilter = (g: Group) => JSON.stringify(packFilter(g));

/** Number of complete conditions, for a "Filter (3)" button. */
export function countConditions(node: FilterNode | null | undefined): number {
  if (!node) return 0;
  if (node.kind === "cond") return isComplete(node) ? 1 : 0;
  return node.children.reduce((n, c) => n + countConditions(c), 0);
}

// --- Sort ----------------------------------------------------------------------------------------

/** "name,-amount" (the API's list syntax) to sort keys; at most 3, names checked. */
export function parseSort(raw: unknown): Sort[] {
  if (typeof raw !== "string" || !raw) return [];
  const out: Sort[] = [];
  for (const part of raw.split(",").slice(0, 3)) {
    const desc = part.startsWith("-");
    const field = desc ? part.slice(1) : part;
    // A field, or a part of one ("address.city").
    if (!field.split(".").every((x) => NAME.test(x)) || field.split(".").length > 2 || out.some((s) => s.field === field)) continue;
    out.push({ field, dir: desc ? "desc" : "asc" });
  }
  return out;
}

export const formatSort = (sort: Sort[]) => sort.map((s) => (s.dir === "desc" ? `-${s.field}` : s.field)).join(",");

/** Column names from the URL: known-looking names only, at most 100. */
export function parseColumns(raw: unknown): string[] | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw === "") return [];
  const names = raw.split(",").filter((n) => NAME.test(n));
  return [...new Set(names)].slice(0, 100);
}
