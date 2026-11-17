import { Lock } from "lucide-react";
import { useState } from "react";
import { Controller, useForm, type UseFormReturn } from "react-hook-form";
import { FormField } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/overlays";
import type { ApiProblem } from "@/lib/api/problem";
import type { FieldMeta, ObjectMeta, RecordData } from "@/lib/api/types";
import { useSession } from "@/lib/session";
import { canWrite, readOnlyReason, toApiValue, toFormValue, validateValues, type FormValue } from "@/meta/fields";
import { FieldControl } from "@/meta/registry";

/**
 * A record form built from describe: one control per field, client-side checks that mirror the server's
 * rules, and the server's own messages put back on the fields they name. Used to create records and to
 * edit several fields of one at once.
 */

export type Values = Record<string, FormValue>;

export function initialValues(fields: FieldMeta[], record: RecordData | undefined, prefill: Record<string, unknown> = {}): Values {
  const out: Values = {};
  for (const f of fields) {
    const v = record ? record[f.name] : Object.hasOwn(prefill, f.name) ? prefill[f.name] : f.default;
    out[f.name] = toFormValue(f, v);
  }
  return out;
}

/** Form values to an API body: on edit only fields that changed, on create only fields with a value. */
export function bodyFrom(fields: FieldMeta[], values: Values, mode: "create" | "edit", initial?: Values): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const f of fields) {
    const v = toApiValue(f, values[f.name]);
    if (mode === "edit") {
      const before = toApiValue(f, initial?.[f.name]);
      if (JSON.stringify(before) !== JSON.stringify(v)) body[f.name] = v;
    } else if (v !== null && !(Array.isArray(v) && v.length === 0)) {
      body[f.name] = v;
    }
  }
  return body;
}

export function useRecordForm(fields: FieldMeta[], record?: RecordData, prefill?: Record<string, unknown>) {
  const [initial] = useState(() => initialValues(fields, record, prefill));
  const form = useForm<Values>({ defaultValues: initial, mode: "onSubmit" });
  return { form, initial };
}

/** Checks values before sending; marks the fields at fault and returns false when something needs fixing. */
export function checkForm(form: UseFormReturn<Values>, fields: FieldMeta[], mode: "create" | "edit", body: Record<string, unknown>): boolean {
  const all = mode === "create"
    ? Object.fromEntries(fields.map((f) => [f.name, toApiValue(f, form.getValues(f.name))]))
    : body;
  const errors = validateValues(fields.filter((f) => mode === "create" || Object.hasOwn(body, f.name)), all, mode);
  form.clearErrors();
  for (const [name, message] of Object.entries(errors)) form.setError(name, { type: "client", message });
  return Object.keys(errors).length === 0;
}

/** Puts a server refusal on the fields it names; returns the message for anything it couldn't place. */
export function applyServerErrors(form: UseFormReturn<Values>, fields: FieldMeta[], p: ApiProblem): string | null {
  const names = new Set(fields.map((f) => f.name));
  let placed = 0;
  for (const [field, message] of Object.entries(p.fieldErrors)) {
    if (names.has(field)) {
      form.setError(field, { type: "server", message: message.charAt(0).toUpperCase() + message.slice(1) });
      placed++;
    }
  }
  // A 403 naming a field ("can't write deal.amount") belongs on it too.
  const m = /can't write ([\w.]+(?:, [\w.]+)*)/.exec(p.detail);
  if (m) {
    for (const ref of m[1]!.split(", ")) {
      const name = ref.split(".").pop()!;
      if (names.has(name)) {
        form.setError(name, { type: "server", message: "Your role can't change this field" });
        placed++;
      }
    }
  }
  return placed && p.status === 422 ? null : p.detail;
}

export function RecordFields({
  form, fields, meta, mode, record, autoFocusFirst,
}: {
  form: UseFormReturn<Values>; fields: FieldMeta[]; meta: ObjectMeta; mode: "create" | "edit"; record?: RecordData; autoFocusFirst?: boolean;
}) {
  const s = useSession();
  const me = { id: s.member.id, name: s.member.name };
  const values = form.watch();
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
      {fields.map((f, i) => {
        const writable = canWrite(f, meta.access, mode);
        const wide = f.type === "long_text" || f.type === "multi_select" || f.type === "json" || f.type === "address" || (f.type === "relation" && f.relation?.cardinality === "many_to_many");
        const required = Boolean(f.required) && !(mode === "create" && (f.default !== undefined || f.initial !== undefined));
        return (
          <Controller
            key={f.name}
            control={form.control}
            name={f.name}
            render={({ field: rhf, fieldState }) => (
              <FormField
                className={wide ? "sm:col-span-2" : undefined}
                label={f.label}
                required={required && writable}
                error={fieldState.error?.message}
                hint={f.description}
                labelSuffix={writable ? null : (
                  <Tooltip content={readOnlyReason(f, meta.access, mode)}><button type="button" aria-label={`${f.label} is read-only: ${readOnlyReason(f, meta.access, mode)}`} className="rounded-sm text-subtle"><Lock className="size-3" /></button></Tooltip>
                )}
              >
                {(a) => (
                  <FieldControl
                    field={f} meta={meta} record={record} values={values} mode={mode} me={me}
                    value={rhf.value ?? null} onChange={(v) => rhf.onChange(v)} disabled={!writable}
                    id={a.id} describedBy={a["aria-describedby"]} invalid={a["aria-invalid"]} autoFocus={autoFocusFirst && i === 0}
                  />
                )}
              </FormField>
            )}
          />
        );
      })}
    </div>
  );
}
