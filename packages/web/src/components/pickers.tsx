import { useQuery } from "@tanstack/react-query";
import { Command } from "cmdk";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useApi } from "@/lib/api/context";
import type { DirectoryUser, Page, Pipeline, RecordData } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { initials } from "@/lib/format";
import { plainLabel } from "@/lib/text";
import { qk } from "@/lib/keys";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/overlays";

/** A value that settles after `ms` without change (for search-as-you-type). */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** A record's display name by ID (one small read, cached); null until known or when it can't be read. */
export function useRecordName(id: string | null | undefined, known?: string | null) {
  const api = useApi();
  return useQuery({
    queryKey: ["name", id],
    queryFn: async ({ signal }) => (await api.get<{ data: RecordData }>(`/v1/records/${encodeURIComponent(id!)}`, { fields: "display_name" }, signal)).data.display_name ?? null,
    enabled: Boolean(id) && !known,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Members for owner and assignee pickers. Falls back to the users describe listed when the directory is refused. */
export function useUsers(q = "", fallback?: DirectoryUser[]) {
  const api = useApi();
  return useQuery({
    queryKey: qk.users(q),
    queryFn: async ({ signal }) => {
      try {
        return (await api.get<{ data: DirectoryUser[] }>("/v1/users", { q: q || undefined, limit: 50 }, signal)).data;
      } catch (e) {
        if (fallback) return fallback.filter((u) => !q || `${u.name} ${u.email}`.toLowerCase().includes(q.toLowerCase()));
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

const triggerClass =
  "flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-left text-base shadow-sm " +
  "focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted data-[invalid=true]:border-danger";

const listClass = "max-h-64 overflow-y-auto p-1";
const itemClass = "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-base data-[selected=true]:bg-surface-2 aria-disabled:opacity-50";

interface Option { id: string; label: string; hint?: string }

/**
 * The shell every picker shares: a button showing the current choice that opens a searchable list
 * (cmdk: arrow keys move, Enter picks, Escape closes). `onSearch` lets the list come from the server.
 */
function PickerShell({
  id, value, label, placeholder, options, loading, onPick, onSearch, disabled, clearable, describedBy, invalid, emptyText, ariaLabel, footer,
}: {
  id?: string; value: string | null; label: ReactNode; placeholder: string; options: Option[]; loading?: boolean; onPick: (id: string | null, o?: Option) => void;
  onSearch?: (q: string) => void; disabled?: boolean; clearable?: boolean; describedBy?: string; invalid?: boolean; emptyText?: string; ariaLabel?: string; footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => {
    if (!open) setQ("");
  }, [open]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="flex min-w-0 items-center gap-1">
        <PopoverTrigger asChild disabled={disabled}>
          <button type="button" id={id} className={triggerClass} aria-describedby={describedBy} data-invalid={invalid || undefined} aria-label={ariaLabel} aria-haspopup="listbox">
            <span className={cn("truncate", !value && "text-subtle")}>{value ? label : placeholder}</span>
            <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-subtle" />
          </button>
        </PopoverTrigger>
        {clearable && value && !disabled ? (
          <button type="button" className="rounded-sm p-1 text-subtle hover:bg-surface-2 hover:text-fg" aria-label="Clear" onClick={() => onPick(null)}>
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-64 p-0" align="start">
        <Command shouldFilter={!onSearch} label={typeof placeholder === "string" ? placeholder : "Pick"}>
          <Command.Input
            value={q}
            onValueChange={(v) => {
              setQ(v);
              onSearch?.(v);
            }}
            placeholder="Search…"
            className="h-9 w-full border-b border-line bg-transparent px-3 text-base outline-none placeholder:text-subtle"
          />
          <Command.List className={listClass}>
            {loading ? <Command.Loading><div className="px-2 py-1.5 text-sm text-muted">Searching…</div></Command.Loading> : null}
            <Command.Empty className="px-2 py-1.5 text-sm text-muted">{emptyText ?? "Nothing found"}</Command.Empty>
            {options.map((o) => (
              <Command.Item key={o.id} value={`${o.label} ${o.hint ?? ""} ${o.id}`} onSelect={() => {
                onPick(o.id, o);
                setOpen(false);
              }} className={itemClass}>
                <Check aria-hidden className={cn("size-3.5 shrink-0", o.id === value ? "text-accent" : "invisible")} />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.hint ? <span className="truncate text-sm text-subtle">{o.hint}</span> : null}
              </Command.Item>
            ))}
          </Command.List>
          {footer}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Records of `object` found by name: the search endpoint once two characters are typed, the most recent ones before that. */
function useRecordOptions(object: string, q: string) {
  const api = useApi();
  const term = useDebounced(q.trim(), 250);
  return useQuery({
    queryKey: ["picker", object, term],
    queryFn: async ({ signal }) => {
      if (term.length >= 2) {
        try {
          const r = await api.get<{ data: RecordData[] }>("/v1/search", { q: term, objects: object, limit: 20 }, signal);
          return r.data;
        } catch {
          // Not every object is searchable: fall back to recent records, matched by name here.
          const r = await api.get<Page>(`/v1/objects/${encodeURIComponent(object)}/records`, { limit: 200, sort: "-updated_at", fields: "display_name" }, signal);
          return r.data.filter((x) => (x.display_name ?? "").toLowerCase().includes(term.toLowerCase())).slice(0, 20);
        }
      }
      const r = await api.get<Page>(`/v1/objects/${encodeURIComponent(object)}/records`, { limit: 20, sort: "-updated_at", fields: "display_name" }, signal);
      return r.data;
    },
    staleTime: 30_000,
  });
}

/** Picks one record of `object`, searching as you type. `known` is the current record's name, when the caller has it (include). */
export function RecordPicker({
  object, value, onChange, known, id, describedBy, invalid, disabled, placeholder, ariaLabel,
}: {
  object: string; value: string | null; onChange: (id: string | null) => void; known?: string | null; id?: string; describedBy?: string;
  invalid?: boolean; disabled?: boolean; placeholder?: string; ariaLabel?: string;
}) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Record<string, string>>({});
  const opts = useRecordOptions(object, q);
  const name = useRecordName(value, value ? picked[value] ?? known : null);
  const label = value ? picked[value] ?? known ?? name.data ?? (name.isLoading ? "Loading…" : value) : "";
  const options = (opts.data ?? []).map((r) => ({ id: r.id, label: plainLabel(r.display_name) || "(no name)" }));
  return (
    <PickerShell
      id={id} value={value} label={label} placeholder={placeholder ?? "Choose…"} options={options} loading={opts.isFetching}
      onSearch={setQ} describedBy={describedBy} invalid={invalid} disabled={disabled} clearable ariaLabel={ariaLabel}
      emptyText={q.trim().length === 1 ? "Type one more character" : "No records found"}
      onPick={(v, o) => {
        if (v && o) setPicked((p) => ({ ...p, [v]: o.label }));
        onChange(v);
      }}
    />
  );
}

/** Picks several records of `object` (a many-to-many relation): chips for the chosen ones, a picker to add more. */
export function MultiRecordPicker({ object, value, onChange, id, describedBy, disabled }: {
  object: string; value: string[]; onChange: (ids: string[]) => void; id?: string; describedBy?: string; disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {value.length ? (
        <ul className="flex flex-wrap gap-1" aria-label="Chosen records">
          {value.map((rid) => <RecordChip key={rid} id={rid} onRemove={disabled ? undefined : () => onChange(value.filter((x) => x !== rid))} />)}
        </ul>
      ) : null}
      {disabled ? null : (
        <RecordPicker object={object} value={null} id={id} describedBy={describedBy} placeholder="Add…"
          onChange={(rid) => rid && !value.includes(rid) && onChange([...value, rid])} />
      )}
    </div>
  );
}

function RecordChip({ id, onRemove }: { id: string; onRemove?: () => void }) {
  const name = useRecordName(id);
  const label = name.data ?? (name.isPending ? "Loading…" : "A record you can't see");
  return (
    <li className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface-2 py-0.5 pl-1.5 pr-0.5 text-sm">
      <span className="max-w-48 truncate"><bdi>{label}</bdi></span>
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={`Remove ${plainLabel(label)}`} className="rounded-sm p-0.5 text-subtle hover:bg-surface-3 hover:text-fg"><X className="size-3" /></button>
      ) : null}
    </li>
  );
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[10px] font-semibold text-accent-soft-fg", className)}>
      {initials(name)}
    </span>
  );
}

/** Picks a member (owner, assignee). `me` adds a "Me" shortcut at the top. */
export function UserPicker({ value, onChange, known, fallback, id, describedBy, invalid, disabled, me, ariaLabel }: {
  value: string | null; onChange: (id: string | null) => void; known?: string | null; fallback?: DirectoryUser[]; id?: string;
  describedBy?: string; invalid?: boolean; disabled?: boolean; me?: { id: string; name: string }; ariaLabel?: string;
}) {
  const [q, setQ] = useState("");
  const term = useDebounced(q.trim(), 200);
  const users = useUsers(term, fallback);
  const all = useUsers("", fallback);
  const current = value ? (all.data ?? []).find((u) => u.id === value)?.name ?? (users.data ?? []).find((u) => u.id === value)?.name ?? known ?? (me?.id === value ? me.name : value) : "";
  const options: Option[] = useMemo(() => {
    const list = (users.data ?? []).map((u) => ({ id: u.id, label: u.name, hint: u.email }));
    if (me && !term) return [{ id: me.id, label: `${me.name} (me)` }, ...list.filter((u) => u.id !== me.id)];
    return list;
  }, [users.data, me, term]);
  return (
    <PickerShell id={id} value={value} label={current} placeholder="Choose a member…" options={options} loading={users.isFetching}
      onSearch={setQ} onPick={(v) => onChange(v)} describedBy={describedBy} invalid={invalid} disabled={disabled} clearable ariaLabel={ariaLabel}
      emptyText={users.isError ? "The member list isn't available to your role" : "No members found"} />
  );
}

/** Picks a pipeline or one of a pipeline's stages (deals), from describe's pipelines. */
export function PipelinePicker({ pipelines, value, onChange, id, describedBy, invalid, disabled }: {
  pipelines: Pipeline[]; value: string | null; onChange: (id: string | null) => void; id?: string; describedBy?: string; invalid?: boolean; disabled?: boolean;
}) {
  return (
    <select id={id} aria-describedby={describedBy} aria-invalid={invalid} disabled={disabled} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}
      className="h-8 w-full rounded-md border border-line-strong bg-surface px-2 text-base shadow-sm focus-visible:outline-2 focus-visible:outline-focus">
      <option value="">Default pipeline</option>
      {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}{p.is_default ? " (default)" : ""}</option>)}
    </select>
  );
}

export function StagePicker({ pipelines, pipeline, value, onChange, id, describedBy, invalid, disabled, includeEmpty = true }: {
  pipelines: Pipeline[]; pipeline: string | null | undefined; value: string | null; onChange: (id: string | null) => void; id?: string;
  describedBy?: string; invalid?: boolean; disabled?: boolean; includeEmpty?: boolean;
}) {
  const p = pipelines.find((x) => x.id === pipeline) ?? pipelines.find((x) => x.is_default) ?? pipelines[0];
  return (
    <select id={id} aria-describedby={describedBy} aria-invalid={invalid} disabled={disabled} value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}
      className="h-8 w-full rounded-md border border-line-strong bg-surface px-2 text-base shadow-sm focus-visible:outline-2 focus-visible:outline-focus">
      {includeEmpty ? <option value="">First open stage</option> : null}
      {(p?.stages ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
}
