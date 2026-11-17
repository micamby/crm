import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronDown, Eye, Lock, Pencil, Save, Share2, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FormField, Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/misc";
import {
  ConfirmDialog, Dialog, DialogContent, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger,
} from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import { asProblem } from "@/lib/api/problem";
import type { ObjectMeta, SavedView, Sort, Where } from "@/lib/api/types";
import { qk } from "@/lib/keys";
import { useSession } from "@/lib/session";
import { plainLabel } from "@/lib/text";

/** Saved views of an object that this member can see (personal ones and shared ones). */
export function useViews(object: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.views(object),
    // View names show in menus and headers: no bidirectional controls in them.
    queryFn: async ({ signal }) => (await api.get<{ data: SavedView[] }>(`/v1/objects/${encodeURIComponent(object)}/views`, undefined, signal)).data.map((v) => ({ ...v, name: plainLabel(v.name) })),
    staleTime: 60_000,
  });
}

export interface CurrentDefinition { where: Where | undefined; sort: Sort[]; columns: string[] }

/** Whether this member may change a view: their own personal view, or a shared one with views:manage. */
export const canManageView = (v: SavedView, canShare: boolean) => v.status !== "unavailable" && (v.shared ? canShare : v.mine);

function statusNote(v: SavedView): string | null {
  if (v.status === "unavailable") return "Uses fields your role can't read";
  if (v.status === "broken") return v.problem ?? "No longer fits the schema";
  return null;
}

export function ViewsMenu({ meta, views, current, onApply, definition, modified }: {
  meta: ObjectMeta; views: SavedView[]; current: SavedView | undefined; onApply: (id: string | null) => void;
  definition: CurrentDefinition; modified: boolean;
}) {
  const s = useSession();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const canShare = s.can("views:manage");
  const [dialog, setDialog] = useState<null | "new" | "rename">(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const invalidate = () => qc.invalidateQueries({ queryKey: qk.views(meta.name) });

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<{ data: SavedView }>(`/v1/views/${current!.id}`, body, { ifMatch: current!.version }),
    onSuccess: (r) => {
      void invalidate();
      toast.toast({ tone: "success", title: `Saved "${r.data.name}"` });
      onApply(r.data.id);
    },
    onError: (e) => {
      const p = asProblem(e);
      if (p.status === 412) {
        void invalidate();
        toast.toast({ tone: "error", title: "Changed by someone else", description: "This view was changed since you opened it. It has been reloaded; make your change again." });
      } else toast.error(e, "Couldn't save the view");
    },
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/v1/views/${current!.id}`),
    onSuccess: () => {
      setConfirmDelete(false);
      void invalidate();
      onApply(null);
      toast.toast({ tone: "success", title: "View deleted" });
    },
    onError: (e) => toast.error(e, "Couldn't delete the view"),
  });

  const mine = views.filter((v) => !v.shared);
  const shared = views.filter((v) => v.shared);
  const manageable = current ? canManageView(current, canShare) : false;

  const item = (v: SavedView) => {
    const note = statusNote(v);
    return (
      <MenuItem key={v.id} disabled={v.status !== "ok"} onSelect={() => onApply(v.id)} title={note ?? undefined}>
        {v.status === "ok" ? <Check className={current?.id === v.id ? "text-accent" : "invisible"} /> : v.status === "unavailable" ? <Lock /> : <AlertTriangle />}
        <span className="min-w-0 flex-1 truncate">{v.name}</span>
        {note ? <span className="max-w-32 truncate text-xs text-subtle">{note}</span> : null}
      </MenuItem>
    );
  };

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="ghost" className="max-w-64 font-semibold" aria-label={`View: ${current?.name ?? `All ${meta.plural_label.toLowerCase()}`}${modified ? " (changed)" : ""}`}>
            <Eye /> <span className="truncate">{current?.name ?? `All ${meta.plural_label.toLowerCase()}`}</span>
            {modified ? <span className="size-1.5 rounded-full bg-accent" aria-hidden /> : null}
            <ChevronDown />
          </Button>
        </MenuTrigger>
        <MenuContent align="start" className="w-72">
          <MenuItem onSelect={() => onApply(null)}><Check className={!current ? "text-accent" : "invisible"} /> All {meta.plural_label.toLowerCase()}</MenuItem>
          {mine.length ? <><MenuSeparator /><MenuLabel>My views</MenuLabel>{mine.map(item)}</> : null}
          {shared.length ? <><MenuSeparator /><MenuLabel>Shared with the workspace</MenuLabel>{shared.map(item)}</> : null}
          <MenuSeparator />
          {current && manageable && modified ? (
            <MenuItem disabled={update.isPending} onSelect={() => update.mutate({ where: definition.where ?? null, sort: definition.sort.length ? definition.sort : null, columns: definition.columns })}>
              <Save /> Save changes to "{current.name}"
            </MenuItem>
          ) : null}
          <MenuItem onSelect={() => setDialog("new")}><Save /> Save as a new view…</MenuItem>
          {current && manageable ? (
            <>
              <MenuItem onSelect={() => setDialog("rename")}><Pencil /> Rename…</MenuItem>
              {canShare && current.mine !== undefined ? (
                <MenuItem onSelect={() => update.mutate({ shared: !current.shared })}>
                  {current.shared ? <><Users /> Make personal</> : <><Share2 /> Share with the workspace</>}
                </MenuItem>
              ) : null}
              <MenuItem danger onSelect={() => setConfirmDelete(true)}><Trash2 /> Delete view…</MenuItem>
            </>
          ) : null}
        </MenuContent>
      </Menu>
      {dialog ? (
        <SaveViewDialog meta={meta} mode={dialog} current={current} canShare={canShare} definition={definition}
          onClose={() => setDialog(null)} onSaved={(v) => {
            setDialog(null);
            void invalidate();
            onApply(v.id);
          }} />
      ) : null}
      <ConfirmDialog open={confirmDelete} onOpenChange={setConfirmDelete} danger busy={remove.isPending} confirmLabel="Delete view"
        title={`Delete "${current?.name ?? ""}"?`}
        description={current?.shared ? "It is shared: it disappears for everyone in the workspace. Records are not affected." : "Records are not affected."}
        onConfirm={() => remove.mutate()} />
    </>
  );
}

function SaveViewDialog({ meta, mode, current, canShare, definition, onClose, onSaved }: {
  meta: ObjectMeta; mode: "new" | "rename"; current: SavedView | undefined; canShare: boolean; definition: CurrentDefinition;
  onClose: () => void; onSaved: (v: SavedView) => void;
}) {
  const api = useApi();
  const toast = useToast();
  const [name, setName] = useState(mode === "rename" ? current?.name ?? "" : "");
  const [shared, setShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      if (mode === "rename") return (await api.patch<{ data: SavedView }>(`/v1/views/${current!.id}`, { name: name.trim() }, { ifMatch: current!.version })).data;
      return (await api.post<{ data: SavedView }>("/v1/views", {
        object: meta.name, name: name.trim(), ...(definition.where ? { where: definition.where } : {}),
        ...(definition.sort.length ? { sort: definition.sort } : {}), columns: definition.columns, ...(shared ? { shared: true } : {}),
      })).data;
    },
    onSuccess: (v) => {
      toast.toast({ tone: "success", title: mode === "rename" ? "View renamed" : `Saved "${v.name}"` });
      onSaved(v);
    },
    onError: (e) => setError(asProblem(e).detail),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={mode === "rename" ? "Rename view" : "Save as a new view"}
        description={mode === "new" ? "Keeps this list's filter, sort and columns under a name." : undefined}
        size="sm"
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="save-view" busy={save.isPending} disabled={!name.trim()}>Save</Button></>}
      >
        <form id="save-view" className="flex flex-col gap-4" onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}>
          <FormField label="Name" error={error}>{(p) => <Input {...p} value={name} maxLength={100} autoFocus onChange={(e) => setName(e.target.value)} />}</FormField>
          {mode === "new" ? (
            canShare ? (
              <label className="flex items-center gap-3 text-base">
                <Switch checked={shared} onCheckedChange={setShared} aria-describedby="share-hint" />
                <span>Share with the workspace</span>
              </label>
            ) : <p className="text-sm text-subtle">This view is personal. Sharing views needs the views:manage permission.</p>
          ) : null}
          {mode === "new" && shared ? <p id="share-hint" className="text-sm text-subtle">Everyone who can read {meta.plural_label.toLowerCase()} sees it, with their own access: it never shows anyone more than their role allows.</p> : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}
