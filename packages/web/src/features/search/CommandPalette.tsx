import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { Bell, Columns3, Home, ListChecks, LogOut, Monitor, Moon, Plus, Search, Settings, Sun } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useDebounced } from "@/components/pickers";
import { CreateRecordDialog } from "@/features/create/CreateRecordDialog";
import { useSignOut } from "@/features/shell/signout";
import { useApi } from "@/lib/api/context";
import type { ObjectSummary, RecordData } from "@/lib/api/types";
import { asProblem } from "@/lib/api/problem";
import { qk } from "@/lib/keys";
import { plainLabel } from "@/lib/text";
import { useTheme } from "@/lib/theme";
import { isJunction, navObjects, useObjects } from "@/meta/hooks";
import { ObjectIcon } from "@/meta/icons";

const itemClass =
  "flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-base text-fg data-[selected=true]:bg-surface-2 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted";
const groupClass = "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-subtle";

/**
 * The command palette (⌘K / Ctrl+K): search records across every object you can read, go to any
 * object or page, create a record, switch the theme, sign out. Arrow keys move, Enter runs, Escape closes.
 *
 * Keyboard-first: when record results arrive the first one is selected (unless the person already moved
 * the selection), so typing a name and pressing Enter opens it; "No matches" shows only once a search
 * has settled with nothing; `initialQuery` carries what was typed before the palette's code had loaded.
 */
export function CommandPalette({ open, onOpenChange, initialQuery = "", onReady }: {
  open: boolean; onOpenChange: (o: boolean) => void; initialQuery?: string; onReady?: () => void;
}) {
  const api = useApi();
  const navigate = useNavigate();
  const objects = useObjects();
  const theme = useTheme();
  const signOut = useSignOut();
  const [q, setQ] = useState(initialQuery);
  const [selected, setSelected] = useState("");
  // Whether the person moved the selection themselves since they last typed: then results arriving don't take it.
  const moved = useRef(false);
  const [creating, setCreating] = useState<string | null>(null);
  const term = useDebounced(q.trim(), 200);
  useEffect(() => {
    onReady?.();
  }, [onReady]);
  useEffect(() => {
    if (!open) setQ("");
  }, [open]);
  const searching = q.trim().length >= 2;
  const results = useQuery({
    queryKey: qk.search(term),
    queryFn: ({ signal }) => api.get<{ data: RecordData[] }>("/v1/search", { q: term, limit: 5 }, signal).then((r) => r.data),
    enabled: open && term.length >= 2,
    staleTime: 15_000,
    retry: false,
  });
  const records = searching && term === q.trim() ? results.data ?? [] : [];
  const firstRecord = records[0] ? recordValue(records[0]) : null;
  useEffect(() => {
    if (firstRecord && !moved.current) setSelected(firstRecord);
  }, [firstRecord]);
  const settling = searching && (term !== q.trim() || results.isFetching || results.isPending);
  const all = objects.data ?? [];
  const { standard, custom } = navObjects(all);
  const byName = new Map(all.map((o) => [o.name, o]));
  const go = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };
  const creatable = [...standard.filter((o) => !isJunction(o)), ...custom].filter((o) => o.access.write && o.name !== "activity");

  return (
    <>
      <D.Root open={open} onOpenChange={onOpenChange}>
        <D.Portal>
          <D.Overlay className="fixed inset-0 z-40 bg-overlay animate-fade-in" />
          <D.Content className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-1.5rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-line bg-surface shadow-lg animate-pop-in">
            <D.Title className="sr-only">Search and commands</D.Title>
            <D.Description className="sr-only">Type to search records, or pick a command.</D.Description>
            <Command label="Search and commands" shouldFilter loop value={selected} onValueChange={setSelected}
              onKeyDown={(e) => {
                if (["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(e.key) || (e.ctrlKey && ["n", "p", "j", "k"].includes(e.key))) moved.current = true;
              }}>
              <div className="flex items-center gap-2 border-b border-line px-3">
                <Search aria-hidden className="size-4 text-subtle" />
                <Command.Input value={q} onValueChange={(v) => {
                  moved.current = false;
                  setQ(v);
                }} placeholder="Search records, or type a command…" className="h-12 flex-1 bg-transparent text-md outline-none placeholder:text-subtle" />
              </div>
              <Command.List className="max-h-[60vh] overflow-y-auto p-2" onPointerMove={() => {
                moved.current = true;
              }}>
                {/* Only once nothing matches and no search is still on its way. */}
                {settling || records.length ? null : <Command.Empty className="px-3 py-6 text-center text-base text-muted">No matches</Command.Empty>}
                {searching ? (
                  <Command.Group heading="Records" className={groupClass} forceMount>
                    {settling && !records.length ? <Command.Loading><div className="px-2.5 py-2 text-sm text-muted">Searching…</div></Command.Loading> : null}
                    {results.error && !settling ? <div className="px-2.5 py-2 text-sm text-danger-fg">{asProblem(results.error).detail}</div> : null}
                    {records.map((r) => {
                      const o = byName.get(r.object);
                      return (
                        // Always shown (the server already matched it): the palette's own filter is for commands.
                        <Command.Item key={r.id} value={recordValue(r)} forceMount className={itemClass}
                          onSelect={() => go(() => void navigate({ to: "/o/$object/$id", params: { object: r.object, id: r.id } }))}>
                          {o ? <ObjectIcon object={o} /> : <Search />}
                          <span className="min-w-0 flex-1 truncate"><bdi>{r.display_name || "(no name)"}</bdi></span>
                          <span className="text-sm text-subtle">{o ? plainLabel(o.label) : r.object}</span>
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                ) : null}
                <Command.Group heading="Go to" className={groupClass}>
                  <Item icon={<Home />} onSelect={() => go(() => void navigate({ to: "/" }))}>Home</Item>
                  <Item icon={<Bell />} onSelect={() => go(() => void navigate({ to: "/inbox" }))}>Inbox</Item>
                  <Item icon={<ListChecks />} onSelect={() => go(() => void navigate({ to: "/tasks" }))}>My tasks</Item>
                  {byName.get("deal")?.access.read ? <Item icon={<Columns3 />} onSelect={() => go(() => void navigate({ to: "/board" }))}>Deals board</Item> : null}
                  {[...standard, ...custom].map((o) => (
                    <Item key={o.name} icon={<ObjectIcon object={o} />} keywords={[o.name, o.label]} onSelect={() => go(() => void navigate({ to: "/o/$object", params: { object: o.name }, search: {} }))}>
                      {plainLabel(o.plural_label)}
                    </Item>
                  ))}
                  <Item icon={<Settings />} onSelect={() => go(() => void navigate({ to: "/settings" }))}>Settings</Item>
                </Command.Group>
                {creatable.length ? (
                  <Command.Group heading="Create" className={groupClass}>
                    {creatable.map((o: ObjectSummary) => (
                      <Item key={o.name} icon={<Plus />} keywords={["new", "create", "add", o.name]} onSelect={() => {
                        onOpenChange(false);
                        setCreating(o.name);
                      }}>New {plainLabel(o.label).toLowerCase()}</Item>
                    ))}
                  </Command.Group>
                ) : null}
                <Command.Group heading="Theme" className={groupClass}>
                  <Item icon={<Monitor />} keywords={["theme", "appearance"]} onSelect={() => go(() => theme.setChoice("system"))}>Use the system theme</Item>
                  <Item icon={<Sun />} keywords={["theme", "appearance"]} onSelect={() => go(() => theme.setChoice("light"))}>Light theme</Item>
                  <Item icon={<Moon />} keywords={["theme", "appearance"]} onSelect={() => go(() => theme.setChoice("dark"))}>Dark theme</Item>
                </Command.Group>
                <Command.Group heading="Account" className={groupClass}>
                  <Item icon={<LogOut />} keywords={["log out", "logout"]} onSelect={() => go(() => void signOut())}>Sign out</Item>
                </Command.Group>
              </Command.List>
            </Command>
          </D.Content>
        </D.Portal>
      </D.Root>
      {creating ? <CreateRecordDialog object={creating} open onOpenChange={(o) => !o && setCreating(null)} /> : null}
    </>
  );
}

const recordValue = (r: RecordData) => `record:${r.id}`;

function Item({ icon, children, onSelect, keywords }: { icon: ReactNode; children: ReactNode; onSelect: () => void; keywords?: string[] }) {
  return (
    <Command.Item className={itemClass} onSelect={onSelect} keywords={keywords}>
      {icon}
      <span className="flex-1 truncate">{children}</span>
    </Command.Item>
  );
}
