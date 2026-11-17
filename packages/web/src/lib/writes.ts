import { useQueryClient, type InfiniteData, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback } from "react";
import type { Page, RecordData } from "./api/types";
import { qk } from "./keys";

/**
 * What every write to records does to the cache, in one place. A write tells `applyWrite` what it
 * changed (object, record, the server's answer, the records it touched); `applyWrite` then:
 *
 * 1. writes the server's record into the record's own query (so its page shows it at once, with the new
 *    version, and a later edit there doesn't fail as "changed by someone else"), and into every loaded
 *    list, related list and board row of that record;
 * 2. marks stale everything the change can affect, so what is on screen refetches: the object's lists
 *    and their counts, aggregates and board totals, related lists, the record's (and the touched
 *    records') timelines, search results, and for tasks the inbox and "my tasks".
 *
 * Every useMutation over records calls it (inline and form edits, create, archive, restore, stage moves,
 * bulk changes, task completion, logged activities). Keys are in keys.ts.
 */

export interface WriteEffect {
  /** The object written (its API name). */
  object: string;
  /** The record written, when there is one. */
  id?: string;
  /** The server's answer for it (a PATCH, POST or restore response). */
  record?: RecordData;
  /** Other records the write touched: a task's or activity's related records, a lead's new deal… */
  touched?: { object?: string | null; id: string }[];
  /** The record left lists (archived, merged): drop it from loaded lists right away. */
  removed?: boolean;
  /** The write may have changed records of other objects too (an operation, a bulk change): refresh those as well. */
  alsoObjects?: string[];
}

type Pages = InfiniteData<Page, unknown>;
const isPages = (d: unknown): d is Pages => typeof d === "object" && d !== null && Array.isArray((d as Pages).pages);
const isPage = (d: unknown): d is Page => typeof d === "object" && d !== null && Array.isArray((d as Page).data) && !("pages" in d);

/** The fields of `next` the row already shows, over the row; names of related records kept unless the relation changed. */
function mergeRow(row: RecordData, next: RecordData): RecordData {
  const out: RecordData = { ...row };
  for (const k of Object.keys(row)) if (k !== "included" && Object.hasOwn(next, k)) (out as Record<string, unknown>)[k] = next[k];
  for (const k of ["version", "updated_at", "display_name", "archived_at"]) if (Object.hasOwn(next, k)) (out as Record<string, unknown>)[k] = next[k];
  if (row.included) {
    const inc = { ...row.included };
    for (const k of Object.keys(inc)) if (Object.hasOwn(next, k) && next[k] !== row[k]) delete inc[k];
    out.included = next.included ? { ...inc, ...next.included } : inc;
  }
  return out;
}

/** Relations whose value changed, so the names shown for them (from include) are stale. */
function relationChanged(prev: RecordData | undefined, next: RecordData): boolean {
  if (!prev?.included) return false;
  return Object.keys(prev.included).some((k) => Object.hasOwn(next, k) && JSON.stringify(next[k]) !== JSON.stringify(prev[k]));
}

function patchRows(qc: QueryClient, prefix: QueryKey, id: string, next: RecordData | null) {
  qc.setQueriesData({ queryKey: prefix }, (d: unknown) => {
    const fix = (p: Page): Page => ({ ...p, data: next ? p.data.map((r) => (r.id === id ? mergeRow(r, next) : r)) : p.data.filter((r) => r.id !== id) });
    if (isPages(d)) return { ...d, pages: d.pages.map(fix) };
    if (isPage(d)) return fix(d);
    return d;
  });
}

export function applyWrite(qc: QueryClient, e: WriteEffect): void {
  const { object, id, record } = e;
  let keepRecord = false;
  if (id && record && !e.removed) {
    const key = qk.record(object, id);
    const prev = qc.getQueryData<RecordData>(key);
    const changedRelation = relationChanged(prev, record);
    // A PATCH answer carries no `include`: keep the names of related records unless a relation changed (then refetch it).
    qc.setQueryData<RecordData>(key, { ...record, ...(prev?.included && !changedRelation ? { included: { ...prev.included, ...(record.included ?? {}) } } : {}) });
    keepRecord = !changedRelation;
    for (const part of ["list", "related"] as const) patchRows(qc, ["records", object, part], id, record);
    if (object === "deal") patchRows(qc, ["records", "deal", "board"], id, record);
  } else if (id && e.removed) {
    for (const part of ["list", "related"] as const) patchRows(qc, ["records", object, part], id, null);
  }

  // Everything about the object, but the record just written (unless its related names went stale).
  const recordKey = id ? JSON.stringify(qk.record(object, id)) : null;
  void qc.invalidateQueries({ queryKey: qk.records(object), predicate: (q) => !(keepRecord && JSON.stringify(q.queryKey) === recordKey) });
  for (const o of e.alsoObjects ?? []) if (o !== object) void qc.invalidateQueries({ queryKey: qk.records(o) });

  // Timelines: the record's own and the touched records'; tasks and activities appear on their related records' timelines.
  if (object === "task" || object === "activity") void qc.invalidateQueries({ queryKey: ["timeline"] });
  else if (id) void qc.invalidateQueries({ queryKey: qk.timeline(id) });
  for (const t of e.touched ?? []) {
    void qc.invalidateQueries({ queryKey: qk.timeline(t.id) });
    if (t.object) void qc.invalidateQueries({ queryKey: qk.record(t.object, t.id) });
  }

  // Names in search results and pickers.
  void qc.invalidateQueries({ queryKey: ["search"] });
  void qc.invalidateQueries({ queryKey: ["picker", object] });
  if (id) void qc.invalidateQueries({ queryKey: ["name", id] });

  // A task's state shows in the inbox (overdue tasks, counts) and in "my tasks" (under ["records", "task"], done above).
  if (object === "task") void qc.invalidateQueries({ queryKey: ["inbox"] });
}

/** applyWrite bound to the app's query client. */
export function useApplyWrite(): (e: WriteEffect) => void {
  const qc = useQueryClient();
  return useCallback((e: WriteEffect) => applyWrite(qc, e), [qc]);
}

/** The records a task or activity refers to (`related` from the API, or `related_to` sent), for applyWrite's `touched`. */
export function touchedBy(rec: object | undefined): { object?: string | null; id: string }[] {
  const r = rec as { related?: unknown; related_to?: unknown } | undefined;
  const out: { object?: string | null; id: string }[] = [];
  if (Array.isArray(r?.related)) for (const x of r.related) if (x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string") out.push({ object: (x as { object?: string | null }).object ?? null, id: (x as { id: string }).id });
  if (Array.isArray(r?.related_to)) for (const x of r.related_to) if (typeof x === "string" && !out.some((o) => o.id === x)) out.push({ id: x });
  return out;
}
