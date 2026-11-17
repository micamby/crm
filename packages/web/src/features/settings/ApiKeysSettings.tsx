import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, MoreHorizontal, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { ProblemAlert, ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { FormField, Input, NativeSelect } from "@/components/ui/input";
import { Badge, Checkbox, Skeleton } from "@/components/ui/misc";
import { ConfirmDialog, Dialog, DialogContent, Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import { asProblem, type ApiProblem } from "@/lib/api/problem";
import type { ApiKey, Members } from "@/lib/api/types";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useSession } from "@/lib/session";
import { SecretDialog } from "./SecretDialog";
import { Section, SimpleTable, useAdmin } from "./SettingsLayout";

const SCOPES: [string, string][] = [
  ["ops:read", "Read records"], ["ops:write", "Create and change records"], ["restricted:read", "See restricted values"], ["admin", "Schema, members, keys and configuration"],
];

export function ApiKeysSettings() {
  const s = useSession();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const keys = useAdmin<{ data: ApiKey[] }>(["keys"], "/v1/api-keys");
  const members = useAdmin<{ data: Members }>(["members"], "/v1/members", undefined, s.can("members:manage"));
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [rotating, setRotating] = useState<ApiKey | null>(null);
  const [rotateError, setRotateError] = useState<ApiProblem | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "keys"] });
  const ownerName = (id: string) => members.data?.data.users.find((u) => u.id === id)?.name ?? members.data?.data.service_accounts.find((a) => a.id === id)?.name ?? (id === s.member.id ? s.member.name : id);
  const revoke = useMutation({
    mutationFn: (k: ApiKey) => api.post(`/v1/api-keys/${encodeURIComponent(k.id)}/revoke`),
    onSuccess: () => { setRevoking(null); void refresh(); toast.toast({ tone: "success", title: "Key revoked" }); },
    onError: (e) => { setRevoking(null); toast.error(e, "Couldn't revoke"); },
  });
  const rotate = useMutation({
    // The answer holds the new secret: dropped from the mutation cache as soon as nothing shows it (reset() on close).
    gcTime: 0,
    mutationFn: (v: { k: ApiKey; hours: number }) => api.post<{ data: { secret: string } }>(`/v1/api-keys/${encodeURIComponent(v.k.id)}/rotate`, { overlap_hours: v.hours }),
    onSuccess: (r, v) => { setRotating(null); void refresh(); setSecret({ title: `New secret for ${v.k.name}`, value: r.data.secret }); },
    onError: (e) => setRotateError(asProblem(e)),
  });
  const live = (keys.data?.data ?? []).filter((k) => !k.revoked_at);
  const revoked = (keys.data?.data ?? []).filter((k) => k.revoked_at);
  return (
    <>
      <Section title="API keys" description="Keys are for scripts, integrations, agents and the crm CLI. A key acts as its owner, narrowed by its scopes, and outlives browser sessions."
        actions={<Button size="sm" variant="primary" onClick={() => setCreating(true)}><Plus /> New key</Button>}>
        {keys.isPending ? <Skeleton className="h-24" /> : keys.error ? <ProblemView error={keys.error} compact /> : live.length === 0 ? <p className="text-base text-muted">No active keys.</p> : (
          <SimpleTable label="API keys" head={["Key", "Owner", "Scopes", "Last used", "Expires", ""]}>
            {live.map((k) => (
              <tr key={k.id}>
                <td className="px-4 py-2"><p className="font-medium">{k.name}</p><p className="font-mono text-sm text-subtle">{k.hint} {k.environment === "test" ? <Badge tone="warning">test</Badge> : null}</p></td>
                <td className="px-4 py-2 text-sm">{ownerName(k.owner)}</td>
                <td className="px-4 py-2"><div className="flex flex-wrap gap-1">{k.scopes.map((x) => <Badge key={x}>{x}</Badge>)}</div></td>
                <td className="px-4 py-2 text-sm">{k.last_used_at ? formatRelative(k.last_used_at) : "Never"}</td>
                <td className="px-4 py-2 text-sm">{k.expires_at ? formatDateTime(k.expires_at) : "Never"}</td>
                <td className="px-4 py-2 text-right">
                  <Menu>
                    <MenuTrigger asChild><Button size="icon-sm" variant="subtle" aria-label={`Actions for ${k.name}`}><MoreHorizontal /></Button></MenuTrigger>
                    <MenuContent align="end">
                      <MenuItem onSelect={() => { setRotateError(null); setRotating(k); }}><RefreshCw /> Rotate…</MenuItem>
                      <MenuItem danger onSelect={() => setRevoking(k)}><Trash2 /> Revoke…</MenuItem>
                    </MenuContent>
                  </Menu>
                </td>
              </tr>
            ))}
          </SimpleTable>
        )}
        {revoked.length ? <p className="mt-3 text-sm text-subtle">{revoked.length} revoked key{revoked.length === 1 ? "" : "s"} not shown.</p> : null}
      </Section>
      {creating ? <CreateKeyDialog members={members.data?.data} onClose={() => setCreating(false)} onCreated={(name, value) => {
        setCreating(false);
        void refresh();
        setSecret({ title: `Your new key: ${name}`, value });
      }} /> : null}
      {secret ? <SecretDialog title={secret.title} secret={secret.value} note="Anyone with this key can act as its owner within its scopes. Store it in a password manager or your deployment's secret store." onClose={() => {
        setSecret(null);
        rotate.reset();
      }} /> : null}
      <ConfirmDialog open={revoking !== null} onOpenChange={(o) => !o && setRevoking(null)} danger busy={revoke.isPending} confirmLabel="Revoke key"
        title={`Revoke ${revoking?.name ?? ""}?`} description="Anything using it stops working at once. This can't be undone." onConfirm={() => revoking && revoke.mutate(revoking)} />
      {rotating ? <RotateDialog k={rotating} error={rotateError} busy={rotate.isPending} onClose={() => setRotating(null)} onRotate={(hours) => rotate.mutate({ k: rotating, hours })} /> : null}
    </>
  );
}

function RotateDialog({ k, error, busy, onClose, onRotate }: { k: ApiKey; error: ApiProblem | null; busy: boolean; onClose: () => void; onRotate: (h: number) => void }) {
  const [hours, setHours] = useState(24);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title={`Rotate ${k.name}`} description="Issues a new secret. The old one keeps working for the overlap, so you can switch without downtime."
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} onClick={() => onRotate(hours)}><RefreshCw /> Rotate</Button></>}>
        <div className="grid gap-3">
          {error ? <ProblemAlert error={error} /> : null}
          <FormField label="Old secret keeps working for">{(p) => (
            <NativeSelect {...p} value={hours} onChange={(e) => setHours(Number(e.target.value))}>
              {[0, 1, 24, 72, 168].map((h) => <option key={h} value={h}>{h === 0 ? "No overlap: stop it now" : `${h} hour${h === 1 ? "" : "s"}`}</option>)}
            </NativeSelect>
          )}</FormField>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CreateKeyDialog({ members, onClose, onCreated }: { members?: Members; onClose: () => void; onCreated: (name: string, secret: string) => void }) {
  const api = useApi();
  const s = useSession();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<string>>(new Set(["ops:read", "ops:write"]));
  const [owner, setOwner] = useState(s.member.id);
  const [env, setEnv] = useState<"live" | "test">("live");
  const [days, setDays] = useState("90");
  const [error, setError] = useState<ApiProblem | null>(null);
  const create = useMutation({
    // The answer holds the secret: not kept in the mutation cache once this dialog is gone.
    gcTime: 0,
    mutationFn: () => api.post<{ data: { secret: string } }>("/v1/api-keys", {
      name: name.trim(), scopes: [...scopes], environment: env, ...(owner !== s.member.id ? { owner } : {}), ...(days ? { expires_in_days: Number(days) } : {}),
    }),
    onSuccess: (r) => {
      onCreated(name, r.data.secret);
      create.reset();
    },
    onError: (e) => setError(asProblem(e)),
  });
  const owners = [...(members?.users.filter((u) => u.active) ?? []), ...(members?.service_accounts.filter((a) => a.active) ?? [])];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="New API key" description="Keys can carry only scopes their owner's role can use. From a browser, this needs a sign-in in the last 10 minutes."
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="new-key" busy={create.isPending} disabled={!name.trim() || scopes.size === 0}><KeyRound /> Create key</Button></>}>
        <form id="new-key" className="grid gap-3.5" onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutate();
        }}>
          {error ? <ProblemAlert error={error} /> : null}
          <FormField label="Name" required hint="What uses it, e.g. Billing sync">{(p) => <Input {...p} autoFocus value={name} onChange={(e) => setName(e.target.value)} />}</FormField>
          <fieldset><legend className="mb-1.5 text-sm font-medium text-muted">Scopes</legend>
            <div className="grid gap-1.5">{SCOPES.map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-base"><Checkbox checked={scopes.has(k)} onCheckedChange={(v) => {
                const n = new Set(scopes);
                if (v === true) n.add(k); else n.delete(k);
                setScopes(n);
              }} /><code className="font-mono text-sm">{k}</code><span className="text-muted">{label}</span></label>
            ))}</div>
          </fieldset>
          <div className="grid gap-3.5 sm:grid-cols-3">
            {owners.length ? <FormField label="Owner">{(p) => <NativeSelect {...p} value={owner} onChange={(e) => setOwner(e.target.value)}>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}{o.id === s.member.id ? " (you)" : ""}</option>)}</NativeSelect>}</FormField> : null}
            <FormField label="Environment" hint="A label: test keys reach live data too">{(p) => <NativeSelect {...p} value={env} onChange={(e) => setEnv(e.target.value as "live" | "test")}><option value="live">live</option><option value="test">test</option></NativeSelect>}</FormField>
            <FormField label="Expires after">{(p) => <NativeSelect {...p} value={days} onChange={(e) => setDays(e.target.value)}>{[["30", "30 days"], ["90", "90 days"], ["365", "1 year"], ["", "Never"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</NativeSelect>}</FormField>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
