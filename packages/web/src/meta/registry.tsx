import { Link } from "@tanstack/react-router";
import { Check, Lock, Minus, Star } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Avatar, MultiRecordPicker, PipelinePicker, RecordPicker, StagePicker, UserPicker, useRecordName } from "@/components/pickers";
import { Badge } from "@/components/ui/misc";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/misc";
import type { FieldMeta, FieldType, ObjectMeta, Pipeline, RecordData } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import type { Scalar, UiOp } from "@/lib/filters";
import { takesList } from "@/lib/filters";
import { formatDate, formatDateTime, formatMoney, formatNumber, fromLocalInput, toLocalInput } from "@/lib/format";
import { mailtoHref, safeHref, telHref } from "@/lib/safe-url";
import { plainLabel } from "@/lib/text";
import { countryName, countryOptions } from "./countries";
import { addressLine, addressParts, allowedStatuses, formatDuration, isEntity, isRestrictedValue, JSON_MAX_BYTES, optionLabel, parseDuration, toneFor, type FormValue } from "./fields";

/**
 * The field registry: for each of the 19 field types, how a value is shown (FieldValue), edited
 * (FieldControl) and filtered (FilterValueInput). Everything is driven by the field's describe entry;
 * relation fields link to the related record by name (from `include`) and edit through a search picker.
 *
 * Every value is rendered inside <bdi> (or as an isolated element), so text with bidirectional controls
 * can't reorder what is around it; select and status labels also lose the controls (lib/text.ts).
 *
 * A type this version doesn't know (a newer server) is shown read-only as its raw value, as text:
 * no editor (canWrite says no), "is empty" as its only filter, no sorting (meta/fields.ts).
 */

/** Right-aligned columns. */
export const isNumeric = (t: FieldType) => t === "number" || t === "currency" || t === "percent" || t === "duration" || t === "rating";

/** A value of an unknown type as text: strings as they are, anything else as compact JSON. */
export function rawText(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** A rating as stars, read by screen readers as "3 out of 5". */
export function Stars({ value, max }: { value: number; max: number }) {
  const n = Math.max(0, Math.min(max, Math.round(value)));
  return (
    <span role="img" aria-label={`${n} out of ${max}`} className="inline-flex items-center text-warning">
      {Array.from({ length: max }, (_, i) => <Star key={i} aria-hidden className={cn("size-3.5", i < n ? "fill-current" : "text-line-strong")} />)}
    </span>
  );
}

const Empty = () => <span className="text-subtle" aria-label="empty">—</span>;

function RestrictedBadge() {
  return (
    <span title="Restricted: your role can't see this value" className="inline-flex items-center gap-1 rounded-sm bg-surface-2 px-1.5 text-sm text-muted">
      <Lock aria-hidden className="size-3" /> Restricted
    </span>
  );
}

function urlLabel(href: string): string {
  try {
    const u = new URL(href);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return href;
  }
}

/** The currency of an amount on a record: the record's own `currency` field when it has one (deals), else the workspace's. */
export function currencyOf(record: RecordData | undefined, meta: Pick<ObjectMeta, "currency"> | undefined): string | undefined {
  const own = record?.currency;
  return typeof own === "string" && own ? own : meta?.currency;
}

/** A link to a record's page, by object and ID. */
export function RecordLink({ object, id, children, className }: { object: string; id: string; children: ReactNode; className?: string }) {
  return (
    <Link to="/o/$object/$id" params={{ object, id }} className={cn("text-accent hover:underline focus-visible:outline-2 focus-visible:outline-focus", className)}>
      <bdi>{children}</bdi>
    </Link>
  );
}

/**
 * A field's value for reading. `variant="cell"` keeps it on one line (tables, cards); `"full"` shows
 * long text in full (record pages).
 */
export function FieldValue({ field, value, record, meta, variant = "cell" }: {
  field: FieldMeta; value: unknown; record?: RecordData; meta?: Pick<ObjectMeta, "currency"> & Partial<Pick<ObjectMeta, "pipelines">>; variant?: "cell" | "full";
}) {
  if (isRestrictedValue(value)) return <RestrictedBadge />;
  if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return <Empty />;
  const one = variant === "cell" ? "block truncate" : "";
  switch (field.type) {
    case "text": return <bdi className={one}>{String(value)}</bdi>;
    case "long_text": return variant === "cell" ? <bdi className={one}>{String(value).split("\n")[0]}</bdi> : <bdi className="block whitespace-pre-wrap break-words">{String(value)}</bdi>;
    case "number": return <span className="tabular">{formatNumber(value)}</span>;
    case "currency": return <span className="tabular">{formatMoney(value, currencyOf(record, meta))}</span>;
    case "boolean": return value ? <span className="inline-flex items-center gap-1"><Check aria-hidden className="size-3.5 text-success" />Yes</span>
      : <span className="inline-flex items-center gap-1 text-muted"><Minus aria-hidden className="size-3.5" />No</span>;
    case "date": return <span className="tabular" title={String(value)}>{formatDate(value)}</span>;
    case "datetime": return <time dateTime={String(value)} className="tabular" title={String(value)}>{formatDateTime(value)}</time>;
    case "single_select": return <Badge><bdi>{plainLabel(optionLabel(field, value))}</bdi></Badge>;
    case "status": {
      const cat = field.values?.find((v) => v.key === value)?.category;
      return <Badge tone={toneFor(cat)}><bdi>{plainLabel(optionLabel(field, value))}</bdi></Badge>;
    }
    case "multi_select": {
      const list = Array.isArray(value) ? value : [];
      return <span className={cn("flex gap-1", variant === "cell" ? "overflow-hidden" : "flex-wrap")}>{list.map((k) => <Badge key={String(k)}><bdi>{plainLabel(optionLabel(field, k))}</bdi></Badge>)}</span>;
    }
    case "email": {
      const href = mailtoHref(value);
      return href ? <a href={href} className={cn("text-accent hover:underline", one)}><bdi>{String(value)}</bdi></a> : <bdi className={one}>{String(value)}</bdi>;
    }
    case "phone": {
      const href = telHref(value);
      return href ? <a href={href} className={cn("text-accent hover:underline tabular", one)}><bdi>{String(value)}</bdi></a> : <bdi className={one}>{String(value)}</bdi>;
    }
    case "url": {
      const href = safeHref(value);
      return href ? <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={cn("text-accent hover:underline", one)}><bdi>{urlLabel(href)}</bdi></a> : <bdi className={one}>{String(value)}</bdi>;
    }
    case "relation": return <RelationValue field={field} value={value} record={record} variant={variant} pipelines={meta?.pipelines} />;
    case "address": {
      const line = addressLine(value);
      if (!line) return <Empty />;
      if (variant === "cell") return <bdi className={one} title={line}>{line}</bdi>;
      const a = value as Record<string, unknown>;
      // The server always sends every part (null when empty) and a one-line display built from them: lay the parts out
      // on lines as a postal address (city, region postal code), and fall back to display only when there are no parts.
      const has = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";
      const cityLine = [a.city, [a.region, a.postal_code].filter(has).join(" ")].filter(has).join(", ");
      const fromParts = [a.line1, a.line2, cityLine, has(a.country) ? countryName(a.country) : null].filter(has);
      const lines = fromParts.length ? fromParts : [line];
      return <address className="not-italic">{lines.map((l, i) => <bdi key={i} className="block">{l}</bdi>)}</address>;
    }
    case "json": {
      const text = rawText(value);
      if (variant === "cell") return <code className={cn("font-mono text-sm", one)} title={text.length > 300 ? `${text.slice(0, 300)}…` : text}><bdi>{text}</bdi></code>;
      return <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-2 px-2.5 py-1.5 font-mono text-sm"><bdi>{JSON.stringify(value, null, 2)}</bdi></pre>;
    }
    case "rating": return typeof value === "number" ? <Stars value={value} max={field.max ?? 5} /> : <bdi>{rawText(value)}</bdi>;
    case "percent": return typeof value === "number" ? <span className="tabular">{formatNumber(value)}%</span> : <bdi>{rawText(value)}</bdi>;
    case "duration": return typeof value === "number" ? <span className="tabular" title={`${formatNumber(value)} seconds`}>{formatDuration(value)}</span> : <bdi>{rawText(value)}</bdi>;
    // A type this version doesn't know: its raw value, as text.
    default: return <bdi className={cn(one, "text-muted")} title={`${field.type} value`}>{rawText(value)}</bdi>;
  }
}

function RelationValue({ field, value, record, variant, pipelines }: { field: FieldMeta; value: unknown; record?: RecordData; variant: "cell" | "full"; pipelines?: Pipeline[] }) {
  const to = field.relation?.to ?? "";
  if (typeof value === "string" && pipelines && (to === "pipeline" || to === "stage")) {
    const label = to === "pipeline" ? pipelines.find((p) => p.id === value)?.name : pipelines.flatMap((p) => p.stages).find((s) => s.id === value)?.name;
    if (label) return <bdi className={variant === "cell" ? "block truncate" : ""}>{plainLabel(label)}</bdi>;
  }
  if (Array.isArray(value)) {
    return <span className="text-muted">{value.length === 1 ? "1 linked record" : `${value.length} linked records`}</span>;
  }
  if (typeof value !== "string") return <Empty />;
  const inc = record?.included?.[field.name];
  const name = inc?.display_name ?? null;
  if (to === "user") {
    return name ? <span className="inline-flex min-w-0 items-center gap-1.5"><Avatar name={name} /><bdi className="truncate">{name}</bdi></span> : <span className="text-muted">Member</span>;
  }
  if (isEntity(to)) return <bdi className={variant === "cell" ? "block truncate" : ""}>{name ?? "—"}</bdi>;
  if (inc && inc.display_name === null) {
    return <span className="inline-flex items-center gap-1 text-muted" title="Your role can't read these records"><Lock aria-hidden className="size-3" />Not visible</span>;
  }
  return <RecordLink object={to} id={value} className={variant === "cell" ? "block truncate" : ""}>{name !== null ? <bdi>{name}</bdi> : <LinkedName id={value} />}</RecordLink>;
}

/** A related record's name when the list didn't include it: looked up (and cached) by ID, never the ID itself. */
function LinkedName({ id }: { id: string }) {
  const name = useRecordName(id);
  return <bdi>{name.data ?? (name.isPending ? "…" : "Open record")}</bdi>;
}

// --- Editing ------------------------------------------------------------------------------------

export interface ControlProps {
  field: FieldMeta;
  value: FormValue;
  onChange: (v: FormValue) => void;
  /** The object the field belongs to (for relation pickers' extras: users, pipelines). */
  meta: ObjectMeta;
  /** The record being edited, for names of related records (include) and the current status. */
  record?: RecordData;
  /** Other values in the same form (a deal's stage list depends on its pipeline). */
  values?: Record<string, FormValue>;
  mode: "create" | "edit";
  id?: string;
  describedBy?: string;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  me?: { id: string; name: string };
  onCommit?: () => void;
}

/** The input for one field, by type. */
export function FieldControl(p: ControlProps) {
  const { field, value, onChange, id, describedBy, invalid, disabled, autoFocus } = p;
  const common = { id, "aria-describedby": describedBy, "aria-invalid": invalid || undefined, disabled, autoFocus };
  const str = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  const enter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && p.onCommit && !(e.target instanceof HTMLTextAreaElement && !e.metaKey && !e.ctrlKey)) {
      e.preventDefault();
      p.onCommit();
    }
  };
  switch (field.type) {
    case "text": return <Input {...common} value={str} onChange={(e) => onChange(e.target.value)} onKeyDown={enter} maxLength={field.validation?.max_length ?? 2000} />;
    case "long_text": return <Textarea {...common} value={str} onChange={(e) => onChange(e.target.value)} onKeyDown={enter} rows={4} />;
    case "email": return <Input {...common} type="email" autoComplete="off" value={str} onChange={(e) => onChange(e.target.value)} onKeyDown={enter} />;
    case "phone": return <Input {...common} type="tel" autoComplete="off" value={str} onChange={(e) => onChange(e.target.value)} onKeyDown={enter} />;
    case "url": return <Input {...common} type="url" placeholder="https://" value={str} onChange={(e) => onChange(e.target.value)} onKeyDown={enter} />;
    case "number":
      return <Input {...common} inputMode="decimal" className="tabular" value={str} onChange={(e) => onChange(e.target.value)} onKeyDown={enter} />;
    case "currency": {
      const code = currencyOf(p.record, p.meta);
      return (
        <div className="relative">
          <Input {...common} inputMode="decimal" className="tabular pr-12" value={str} onChange={(e) => onChange(e.target.value)} onKeyDown={enter} />
          {code ? <span aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-subtle">{code}</span> : null}
        </div>
      );
    }
    case "boolean":
      return (
        <div className="flex h-8 items-center gap-2">
          <Switch id={id} aria-describedby={describedBy} disabled={disabled} checked={value === true} onCheckedChange={(c) => onChange(c)} autoFocus={autoFocus} />
          <span className="text-base text-muted" aria-hidden>{value === true ? "Yes" : "No"}</span>
        </div>
      );
    case "date": return <Input {...common} type="date" className="tabular" value={str.slice(0, 10)} onChange={(e) => onChange(e.target.value)} onKeyDown={enter} />;
    case "datetime":
      return <Input {...common} type="datetime-local" className="tabular" value={toLocalInput(str)} onChange={(e) => onChange(fromLocalInput(e.target.value) ?? "")} onKeyDown={enter} />;
    case "single_select":
      return (
        <NativeSelect {...common} value={str} onChange={(e) => onChange(e.target.value)} onKeyDown={enter}>
          <option value="">{field.required ? "Choose…" : "—"}</option>
          {(field.values ?? p.meta.activity_types?.map((t) => ({ key: t.key, label: t.label })) ?? []).map((v) => <option key={v.key} value={v.key}>{plainLabel(v.label)}</option>)}
        </NativeSelect>
      );
    case "status": {
      const original = p.mode === "edit" ? p.record?.[field.name] : undefined;
      const allowed = new Set(allowedStatuses(field, original));
      return (
        <NativeSelect {...common} value={str} onChange={(e) => onChange(e.target.value)} onKeyDown={enter}>
          {p.mode === "create" || !original ? <option value="">{field.initial ? `Default (${optionLabel(field, field.initial)})` : "—"}</option> : null}
          {(field.values ?? []).filter((v) => allowed.has(v.key)).map((v) => <option key={v.key} value={v.key}>{plainLabel(v.label)}</option>)}
        </NativeSelect>
      );
    }
    case "multi_select": {
      const set = new Set(Array.isArray(value) ? value : []);
      return (
        <div role="group" aria-describedby={describedBy} className="flex flex-wrap gap-1.5" id={id}>
          {(field.values ?? []).map((v) => {
            const on = set.has(v.key);
            return (
              <button key={v.key} type="button" aria-pressed={on} disabled={disabled}
                onClick={() => onChange(on ? [...set].filter((x) => x !== v.key) : [...set, v.key])}
                className={cn("rounded-sm border px-2 py-0.5 text-sm", on ? "border-accent bg-accent-soft text-accent-soft-fg" : "border-line bg-surface text-muted hover:bg-surface-2")}>
                {v.label}
              </button>
            );
          })}
        </div>
      );
    }
    case "relation": return <RelationControl {...p} />;
    case "address": return <AddressControl {...p} />;
    case "json": return <JsonControl {...p} />;
    case "rating": return <RatingControl {...p} />;
    case "percent":
      return (
        <div className="relative">
          <Input {...common} inputMode="decimal" className="tabular pr-8" value={str} onChange={(e) => onChange(e.target.value)} onKeyDown={enter} />
          <span aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-subtle">%</span>
        </div>
      );
    case "duration": {
      const secs = parseDuration(str);
      return (
        <div>
          <Input {...common} className="tabular" placeholder="e.g. 1h 30m" value={str} onChange={(e) => onChange(e.target.value)} onKeyDown={enter} />
          {str.trim() && secs !== null && !/^\d+$/.test(str.trim()) ? <p className="mt-0.5 text-xs text-subtle">{formatDuration(secs)} ({formatNumber(secs)} seconds)</p> : null}
        </div>
      );
    }
    // Unknown types are never editable (canWrite); shown as their value if a form gets one anyway.
    default: return <p className="text-base text-muted" id={id}><bdi>{rawText(value)}</bdi></p>;
  }
}

/** An address as its parts: lines, city, region, postal code, and a country from the ISO list. */
function AddressControl(p: ControlProps) {
  const { field, value, onChange, id, describedBy, invalid, disabled, autoFocus } = p;
  const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const set = (k: string, x: string) => onChange({ ...v, [k]: x });
  const parts = addressParts(field);
  return (
    <fieldset id={id} aria-describedby={describedBy} className="grid grid-cols-2 gap-2" disabled={disabled}>
      <legend className="sr-only">{field.label}</legend>
      {parts.map((part, i) => {
        const label = part.label ?? part.name;
        const wide = part.name === "line1" || part.name === "line2";
        if (part.name === "country") {
          return (
            <label key={part.name} className="col-span-2 flex flex-col gap-0.5 text-sm text-muted sm:col-span-1">{label}
              <NativeSelect aria-invalid={invalid || undefined} value={v.country ?? ""} onChange={(e) => set("country", e.target.value)}>
                <option value="">—</option>
                {countryOptions().map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </NativeSelect>
            </label>
          );
        }
        return (
          <label key={part.name} className={cn("flex flex-col gap-0.5 text-sm text-muted", wide ? "col-span-2" : "col-span-2 sm:col-span-1")}>{label}
            <Input aria-invalid={invalid || undefined} autoFocus={autoFocus && i === 0} value={v[part.name] ?? ""} onChange={(e) => set(part.name, e.target.value)}
              autoComplete={({ line1: "address-line1", line2: "address-line2", city: "address-level2", region: "address-level1", postal_code: "postal-code" } as Record<string, string>)[part.name] ?? "off"} />
          </label>
        );
      })}
    </fieldset>
  );
}

/** JSON in a monospace editor, checked as you type (the value is sent only when it parses). */
function JsonControl(p: ControlProps) {
  const { value, onChange, id, describedBy, invalid, disabled, autoFocus } = p;
  const str = typeof value === "string" ? value : "";
  let problem: string | null = null;
  if (str.trim()) {
    try {
      const parsed: unknown = JSON.parse(str);
      if (new TextEncoder().encode(JSON.stringify(parsed)).length > JSON_MAX_BYTES) problem = "More than 16 KB of JSON";
    } catch (e) {
      problem = `Not valid JSON: ${(e as Error).message}`;
    }
  }
  return (
    <div>
      <Textarea id={id} aria-describedby={describedBy} aria-invalid={invalid || Boolean(problem) || undefined} disabled={disabled} autoFocus={autoFocus}
        rows={6} spellCheck={false} className="font-mono text-sm" value={str} onChange={(e) => onChange(e.target.value)} placeholder='{"key": "value"}' />
      {problem ? <p className="mt-0.5 text-xs text-danger-fg">{problem}</p> : null}
    </div>
  );
}

/** A rating: a row of stars as a radio group (arrow keys move, Home/End, Delete clears). */
function RatingControl(p: ControlProps) {
  const { field, value, onChange, id, describedBy, disabled, autoFocus } = p;
  const max = Math.max(1, Math.min(10, field.max ?? 5));
  const cur = typeof value === "number" ? value : 0;
  const pick = (n: number) => !disabled && onChange(n < 1 ? null : Math.min(max, n));
  const onKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const next = ({ ArrowRight: cur + 1, ArrowUp: cur + 1, ArrowLeft: cur - 1, ArrowDown: cur - 1, Home: 1, End: max, Delete: 0, Backspace: 0 } as Record<string, number>)[e.key];
    if (next === undefined) {
      if (e.key === "Enter" && p.onCommit) {
        e.preventDefault();
        p.onCommit();
      }
      return;
    }
    e.preventDefault();
    pick(Math.max(0, Math.min(max, next)));
    const group = e.currentTarget.parentElement;
    const target = Math.max(1, Math.min(max, next));
    requestAnimationFrame(() => group?.querySelector<HTMLElement>(`[data-star="${target}"]`)?.focus());
  };
  return (
    <div role="radiogroup" id={id} aria-label={field.label} aria-describedby={describedBy} className="inline-flex items-center gap-0.5">
      {Array.from({ length: max }, (_, i) => {
        const n = i + 1;
        const on = n <= cur;
        return (
          <button key={n} type="button" role="radio" data-star={n} aria-checked={n === cur} aria-label={`${n} of ${max}`} disabled={disabled}
            tabIndex={n === (cur || 1) ? 0 : -1} autoFocus={autoFocus && n === (cur || 1)} onClick={() => pick(n === cur ? 0 : n)} onKeyDown={onKey}
            className="rounded-sm p-0.5 text-warning focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50">
            <Star aria-hidden className={cn("size-5", on ? "fill-current" : "text-line-strong")} />
          </button>
        );
      })}
      {cur ? <button type="button" className="ml-1 text-sm text-muted hover:text-fg" onClick={() => pick(0)} disabled={disabled}>Clear</button> : null}
    </div>
  );
}

function RelationControl(p: ControlProps) {
  const { field, value, onChange, id, describedBy, invalid, disabled } = p;
  const to = field.relation?.to ?? "";
  const known = p.record?.included?.[field.name]?.display_name ?? null;
  if (field.relation?.cardinality === "many_to_many") {
    return <MultiRecordPicker object={to} value={Array.isArray(value) ? value : []} onChange={onChange} id={id} describedBy={describedBy} disabled={disabled} />;
  }
  const v = typeof value === "string" && value ? value : null;
  if (to === "user") {
    return <UserPicker value={v} onChange={onChange} known={known} fallback={p.meta.users} id={id} describedBy={describedBy} invalid={invalid} disabled={disabled} me={p.me} />;
  }
  if (to === "pipeline") {
    return <PipelinePicker pipelines={p.meta.pipelines ?? []} value={v} onChange={(x) => onChange(x ?? "")} id={id} describedBy={describedBy} invalid={invalid} disabled={disabled} />;
  }
  if (to === "stage") {
    const pipeline = typeof p.values?.pipeline === "string" ? p.values.pipeline : (p.record?.pipeline as string | undefined);
    return <StagePicker pipelines={p.meta.pipelines ?? []} pipeline={pipeline} value={v} onChange={(x) => onChange(x ?? "")} id={id} describedBy={describedBy} invalid={invalid} disabled={disabled} />;
  }
  return <RecordPicker object={to} value={v} onChange={(x) => onChange(x ?? "")} known={known} id={id} describedBy={describedBy} invalid={invalid} disabled={disabled} />;
}

// --- Filtering ----------------------------------------------------------------------------------

/** The value input for a filter condition on `field` with operator `op`. */
export function FilterValueInput({ field, op, value, onChange, meta, me, ariaLabel }: {
  field: Pick<FieldMeta, "type" | "values" | "relation" | "name" | "label">; op: UiOp; value: Scalar | Scalar[] | undefined;
  onChange: (v: Scalar | Scalar[] | undefined) => void; meta?: ObjectMeta; me?: { id: string; name: string }; ariaLabel: string;
}) {
  const list = takesList(op);
  const str = typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  const choices = field.values ?? meta?.activity_types?.map((t) => ({ key: t.key, label: t.label }));
  if ((field.type === "single_select" || field.type === "status") && choices) {
    if (list) {
      const set = new Set(Array.isArray(value) ? value.map(String) : []);
      return (
        <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-1">
          {choices.map((v) => {
            const on = set.has(v.key);
            return (
              <button key={v.key} type="button" aria-pressed={on} onClick={() => onChange(on ? [...set].filter((x) => x !== v.key) : [...set, v.key])}
                className={cn("rounded-sm border px-1.5 py-0.5 text-sm", on ? "border-accent bg-accent-soft text-accent-soft-fg" : "border-line text-muted hover:bg-surface-2")}>{plainLabel(v.label)}</button>
            );
          })}
        </div>
      );
    }
    return (
      <NativeSelect aria-label={ariaLabel} value={str} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">Choose…</option>
        {choices.map((v) => <option key={v.key} value={v.key}>{plainLabel(v.label)}</option>)}
      </NativeSelect>
    );
  }
  if (field.type === "multi_select" && choices) {
    return (
      <NativeSelect aria-label={ariaLabel} value={str} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">Choose…</option>
        {choices.map((v) => <option key={v.key} value={v.key}>{plainLabel(v.label)}</option>)}
      </NativeSelect>
    );
  }
  if (field.type === "boolean") {
    return (
      <NativeSelect aria-label={ariaLabel} value={value === true ? "true" : value === false ? "false" : ""} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "true")}>
        <option value="">Choose…</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </NativeSelect>
    );
  }
  if (field.type === "relation") {
    const to = field.relation?.to ?? "";
    if (list) {
      const ids = Array.isArray(value) ? value.map(String) : [];
      if (to === "user") {
        return (
          <div className="flex flex-col gap-1">
            {ids.length ? <p className="text-sm text-muted">{ids.length} chosen</p> : null}
            <UserPicker value={null} me={me} fallback={meta?.users} ariaLabel={ariaLabel} onChange={(x) => x && onChange([...new Set([...ids, x])])} />
          </div>
        );
      }
      if (to === "stage" || to === "pipeline") {
        const opts = to === "pipeline" ? (meta?.pipelines ?? []).map((p) => ({ id: p.id, name: p.name }))
          : (meta?.pipelines ?? []).flatMap((p) => p.stages.map((s) => ({ id: s.id, name: (meta?.pipelines?.length ?? 0) > 1 ? `${p.name}: ${s.name}` : s.name })));
        const set = new Set(ids);
        return (
          <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-1">
            {opts.map((o) => (
              <button key={o.id} type="button" aria-pressed={set.has(o.id)} onClick={() => onChange(set.has(o.id) ? ids.filter((x) => x !== o.id) : [...ids, o.id])}
                className={cn("rounded-sm border px-1.5 py-0.5 text-sm", set.has(o.id) ? "border-accent bg-accent-soft text-accent-soft-fg" : "border-line text-muted hover:bg-surface-2")}>{plainLabel(o.name)}</button>
            ))}
          </div>
        );
      }
      return <MultiRecordPicker object={to} value={ids} onChange={(x) => onChange(x)} />;
    }
    const v = str || null;
    if (to === "user") return <UserPicker value={v} me={me} fallback={meta?.users} ariaLabel={ariaLabel} onChange={(x) => onChange(x ?? undefined)} />;
    if (to === "pipeline") return <PipelinePicker pipelines={meta?.pipelines ?? []} value={v} onChange={(x) => onChange(x ?? undefined)} />;
    if (to === "stage") {
      return (
        <NativeSelect aria-label={ariaLabel} value={str} onChange={(e) => onChange(e.target.value || undefined)}>
          <option value="">Choose…</option>
          {(meta?.pipelines ?? []).map((p) => (
            <optgroup key={p.id} label={p.name}>{p.stages.map((s) => <option key={s.id} value={s.id}>{plainLabel(s.name)}</option>)}</optgroup>
          ))}
        </NativeSelect>
      );
    }
    return <RecordPicker object={to} value={v} ariaLabel={ariaLabel} onChange={(x) => onChange(x ?? undefined)} />;
  }
  if (list) {
    const text = Array.isArray(value) ? value.join(", ") : "";
    return <Input aria-label={ariaLabel} placeholder="Values, separated by commas" value={text}
      onChange={(e) => onChange(e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} />;
  }
  if (field.type === "date") return <Input aria-label={ariaLabel} type="date" value={str.slice(0, 10)} onChange={(e) => onChange(e.target.value || undefined)} />;
  if (field.type === "datetime") {
    return <Input aria-label={ariaLabel} type="datetime-local" value={toLocalInput(str)} onChange={(e) => onChange(fromLocalInput(e.target.value) ?? undefined)} />;
  }
  if (field.type === "number" || field.type === "currency" || field.type === "rating" || field.type === "percent") {
    // Kept as typed: the API reads numbers written as text, typed by the field.
    return (
      <div className="relative">
        <Input aria-label={ariaLabel} inputMode="decimal" className={cn("tabular", field.type === "percent" && "pr-8")} value={str} onChange={(e) => onChange(e.target.value.trim() === "" ? undefined : e.target.value)} />
        {field.type === "percent" ? <span aria-hidden className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-subtle">%</span> : null}
      </div>
    );
  }
  if (field.type === "duration") return <DurationFilterInput ariaLabel={ariaLabel} value={value} onChange={onChange} />;
  return <Input aria-label={ariaLabel} value={str} placeholder={op === "contains" ? "At least 3 characters" : undefined} onChange={(e) => onChange(e.target.value)} />;
}

/** A duration filter: typed as "1h 30m" (or seconds), sent as seconds. */
function DurationFilterInput({ ariaLabel, value, onChange }: { ariaLabel: string; value: Scalar | Scalar[] | undefined; onChange: (v: Scalar | Scalar[] | undefined) => void }) {
  const [text, setText] = useState(() => (typeof value === "number" ? formatDuration(value) : typeof value === "string" ? value : ""));
  const secs = parseDuration(text);
  return (
    <div>
      <Input aria-label={ariaLabel} className="tabular" placeholder="e.g. 1h 30m" value={text} aria-invalid={text.trim() !== "" && secs === null ? true : undefined}
        onChange={(e) => {
          setText(e.target.value);
          const n = parseDuration(e.target.value);
          onChange(n === null ? undefined : n);
        }} />
      {text.trim() && secs === null ? <p className="mt-0.5 text-xs text-danger-fg">Write it like 1h 30m, 45m or 90 (seconds)</p> : null}
    </div>
  );
}
