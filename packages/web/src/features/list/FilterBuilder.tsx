import { Filter, Plus, Trash2, X } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import type { FieldMeta, FieldType, ObjectMeta } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { countConditions, emptyGroup, takesList, takesNoValue, type Condition, type FilterNode, type Group, type UiOp } from "@/lib/filters";
import { useSession } from "@/lib/session";
import { plainLabel } from "@/lib/text";
import { countryOptions } from "@/meta/countries";
import { addressParts, canFilter, ENTITY_FIELDS, isEntity, operatorsFor } from "@/meta/fields";
import { useDescribes } from "@/meta/hooks";
import { FilterValueInput } from "@/meta/registry";

/**
 * The filter builder: conditions in groups matched by all (AND) or any (OR), one level of nested
 * groups, each condition a field (or a field of a related record, one relation away), an operator
 * the field's type supports, and a value. Changes apply as you make them.
 */

export interface PathOption { key: string; path: string[]; label: string; field: Pick<FieldMeta, "type" | "values" | "relation" | "name" | "label">; group: string }

/** The fields a filter can use: this object's, and one hop through each readable many-to-one or many-to-many relation. */
export function usePathOptions(meta: ObjectMeta): { options: PathOption[]; metas: Map<string, ObjectMeta> } {
  const relations = meta.fields.filter((f) => canFilter(f) && f.type === "relation" && f.relation && !isEntity(f.relation.to));
  const targets = [...new Set(relations.map((f) => f.relation!.to))];
  const describes = useDescribes(targets);
  return useMemo(() => {
    const metas = new Map<string, ObjectMeta>([[meta.name, meta]]);
    describes.forEach((d) => d.data && metas.set(d.data.name, d.data));
    const options: PathOption[] = [];
    const own = meta.fields.filter(canFilter);
    for (const f of own) {
      options.push({ key: f.name, path: [f.name], label: plainLabel(f.label), field: f, group: plainLabel(meta.label) });
      // An address filters by each of its parts too (field.city); the country from the ISO list.
      if (f.type === "address") {
        for (const p of addressParts(f)) {
          const part = p.name === "country" ? { name: p.name, label: p.label ?? p.name, type: "single_select" as FieldType, values: countryOptions().map((c) => ({ key: c.code, label: c.name })) }
            : { name: p.name, label: p.label ?? p.name, type: "text" as FieldType };
          options.push({ key: `${f.name}.${p.name}`, path: [f.name, p.name], label: `${plainLabel(f.label)} → ${part.label}`, field: part, group: plainLabel(meta.label) });
        }
      }
    }
    for (const sys of [{ name: "created_at", label: "Created", type: "datetime" as FieldType }, { name: "updated_at", label: "Updated", type: "datetime" as FieldType }]) {
      options.push({ key: sys.name, path: [sys.name], label: sys.label, field: sys, group: meta.label });
    }
    for (const rel of own.filter((f) => f.type === "relation" && f.relation)) {
      // (Related objects' addresses are left out: a part one relation away would be three levels deep.)
      const to = rel.relation!.to;
      if (isEntity(to)) {
        for (const ef of ENTITY_FIELDS[to]!) options.push({ key: `${rel.name}.${ef.name}`, path: [rel.name, ef.name], label: `${rel.label} → ${ef.label}`, field: ef, group: rel.label });
        continue;
      }
      const t = metas.get(to);
      if (!t || !t.access.read) continue;
      for (const tf of t.fields.filter((x) => canFilter(x) && x.type !== "relation" && x.type !== "address")) {
        options.push({ key: `${rel.name}.${tf.name}`, path: [rel.name, tf.name], label: `${rel.label} → ${tf.label}`, field: tf, group: `${rel.label} (${t.label})` });
      }
    }
    return { options, metas };
    // describes' data identity changes when any describe loads
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, describes.map((d) => d.dataUpdatedAt).join(",")]);
}

export function FilterButton({ meta, value, onChange }: { meta: ObjectMeta; value: Group | null; onChange: (g: Group | null) => void }) {
  const n = countConditions(value);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant={n ? "primary" : "secondary"} aria-label={n ? `Filter, ${n} condition${n === 1 ? "" : "s"}` : "Filter"}>
          <Filter /> Filter{n ? <span className="rounded-sm bg-accent-fg/20 px-1 text-xs">{n}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(46rem,calc(100vw-1.5rem))] p-0" align="start">
        <FilterBuilder meta={meta} value={value ?? emptyGroup()} onChange={(g) => onChange(g.children.length ? g : null)} />
      </PopoverContent>
    </Popover>
  );
}

export function FilterBuilder({ meta, value, onChange }: { meta: ObjectMeta; value: Group; onChange: (g: Group) => void }) {
  const { options, metas } = usePathOptions(meta);
  return (
    <div className="p-3">
      <GroupEditor group={value} onChange={onChange} options={options} metas={metas} depth={0} />
      <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
        <p className="text-sm text-subtle">Conditions apply as you complete them.</p>
        {value.children.length ? <Button size="sm" variant="ghost" onClick={() => onChange(emptyGroup())}><X /> Clear all</Button> : null}
      </div>
    </div>
  );
}

function GroupEditor({ group, onChange, onRemove, options, metas, depth }: {
  group: Group; onChange: (g: Group) => void; onRemove?: () => void; options: PathOption[]; metas: Map<string, ObjectMeta>; depth: number;
}) {
  const set = (i: number, n: FilterNode) => onChange({ ...group, children: group.children.map((c, j) => (j === i ? n : c)) });
  const remove = (i: number) => onChange({ ...group, children: group.children.filter((_, j) => j !== i) });
  const first = options[0];
  const add = () => first && onChange({ ...group, children: [...group.children, { kind: "cond", path: first.path, op: operatorsFor(first.field.type)[0]!.op }] });
  return (
    <div className={cn("flex flex-col gap-2", depth > 0 && "rounded-md border border-line bg-surface-2 p-2.5")} role="group" aria-label={depth ? "Condition group" : "Filter conditions"}>
      <div className="flex items-center gap-2 text-sm text-muted">
        <span>Match</span>
        <NativeSelect aria-label="Match all or any conditions" className="h-7 w-auto text-sm" value={group.conj} onChange={(e) => onChange({ ...group, conj: e.target.value as "and" | "or" })}>
          <option value="and">all</option>
          <option value="or">any</option>
        </NativeSelect>
        <span>of these conditions</span>
        {onRemove ? <Button size="icon-sm" variant="subtle" className="ml-auto" aria-label="Remove group" onClick={onRemove}><Trash2 /></Button> : null}
      </div>
      {group.children.length === 0 ? <p className="text-sm text-subtle">No conditions yet.</p> : null}
      {group.children.map((c, i) => c.kind === "group" ? (
        <GroupEditor key={i} group={c} depth={depth + 1} options={options} metas={metas} onChange={(g) => set(i, g)} onRemove={() => remove(i)} />
      ) : (
        <ConditionRow key={i} cond={c} options={options} metas={metas} onChange={(n) => set(i, n)} onRemove={() => remove(i)} index={i} />
      ))}
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={add} disabled={!first}><Plus /> Add condition</Button>
        {depth === 0 ? <Button size="sm" variant="ghost" onClick={() => onChange({ ...group, children: [...group.children, { kind: "group", conj: group.conj === "and" ? "or" : "and", children: [] }] })}><Plus /> Add group</Button> : null}
      </div>
    </div>
  );
}

function ConditionRow({ cond, options, metas, onChange, onRemove, index }: {
  cond: Condition; options: PathOption[]; metas: Map<string, ObjectMeta>; onChange: (c: Condition) => void; onRemove: () => void; index: number;
}) {
  const s = useSession();
  const key = cond.path.join(".");
  const opt = options.find((o) => o.key === key);
  const ops = opt ? operatorsFor(opt.field.type) : [];
  const groups = [...new Set(options.map((o) => o.group))];
  // The first entry of `metas` is the list's own object; a related field's choices come from its object.
  const root = metas.values().next().value as ObjectMeta | undefined;
  const targetMeta = opt && opt.path.length > 1 ? metas.get(root?.fields.find((f) => f.name === opt.path[0])?.relation?.to ?? "") ?? root : root;
  const n = index + 1;
  return (
    <div className="flex flex-wrap items-start gap-2 sm:flex-nowrap">
      <NativeSelect aria-label={`Condition ${n} field`} className="w-full sm:w-52" value={key} onChange={(e) => {
        const o = options.find((x) => x.key === e.target.value);
        if (!o) return;
        const newOps = operatorsFor(o.field.type);
        onChange({ kind: "cond", path: o.path, op: newOps.some((x) => x.op === cond.op) && o.field.type === opt?.field.type ? cond.op : newOps[0]!.op });
      }}>
        {opt ? null : <option value={key}>{key} (not available)</option>}
        {groups.map((g) => (
          <optgroup key={g} label={g}>
            {options.filter((o) => o.group === g).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </optgroup>
        ))}
      </NativeSelect>
      <NativeSelect aria-label={`Condition ${n} operator`} className="w-full sm:w-40" value={cond.op} onChange={(e) => {
        const op = e.target.value as UiOp;
        const value = takesNoValue(op) ? undefined : takesList(op) !== takesList(cond.op) ? undefined : cond.value;
        onChange({ ...cond, op, value });
      }}>
        {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
      </NativeSelect>
      <div className="min-w-0 flex-1">
        {opt && !takesNoValue(cond.op) ? (
          <FilterValueInput field={opt.field} op={cond.op} value={cond.value} meta={targetMeta} me={{ id: s.member.id, name: s.member.name }}
            ariaLabel={`Condition ${n} value`} onChange={(v) => onChange({ ...cond, value: v })} />
        ) : null}
      </div>
      <Button size="icon-sm" variant="subtle" aria-label={`Remove condition ${n}`} onClick={onRemove}><X /></Button>
    </div>
  );
}
