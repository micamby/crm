import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight, Plus, Send, Trash2, Webhook as WebhookIcon } from "lucide-react";
import { useState } from "react";
import { ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { FormField, Input } from "@/components/ui/input";
import { Badge, Skeleton, Switch } from "@/components/ui/misc";
import { ConfirmDialog, Dialog, DialogContent } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import { asProblem } from "@/lib/api/problem";
import type { Delivery, Webhook } from "@/lib/api/types";
import { formatDateTime, formatRelative } from "@/lib/format";
import { SecretDialog } from "./SecretDialog";
import { Section, SimpleTable, useAdmin } from "./SettingsLayout";
import { DocsLink } from "@/lib/docs";

const statusTone = (s: unknown) => (s === "active" || s === "succeeded" ? "success" : s === "paused" || s === "pending" ? "warning" : s === "dead" ? "danger" : "neutral");

export function WebhooksSettings() {
  const hooks = useAdmin<{ data: Webhook[] }>(["webhooks"], "/v1/webhooks");
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const qc = useQueryClient();
  return (
    <>
      <Section title="Webhooks" description={<>Signed HTTPS posts to your endpoints when something happens, such as a deal being created or a contact changed. The <DocsLink page="webhooks.md">webhooks guide</DocsLink> shows how to check the signatures.</>}
        actions={<Button size="sm" variant="primary" onClick={() => setCreating(true)}><Plus /> New webhook</Button>}>
        {hooks.isPending ? <Skeleton className="h-20" /> : hooks.error ? <ProblemView error={hooks.error} compact /> : hooks.data.data.length === 0 ? <p className="text-base text-muted">No webhooks yet.</p> : (
          <ul className="-m-4 divide-y divide-line">
            {hooks.data.data.map((w) => (
              <li key={w.id}>
                <Link to="/settings/webhooks/$webhookId" params={{ webhookId: w.id }} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
                  <WebhookIcon className="size-4 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1"><p className="truncate font-mono text-sm">{w.url}</p><p className="truncate text-sm text-muted">{w.description || (w.events.length ? w.events.join(", ") : "Used by automations only")}</p></div>
                  <Badge tone={statusTone(w.status)}>{String(w.status ?? (w.enabled ? "active" : "disabled"))}</Badge>
                  <ChevronRight className="size-4 text-subtle" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {creating ? <CreateWebhookDialog onClose={() => setCreating(false)} onCreated={(s) => {
        setCreating(false);
        void qc.invalidateQueries({ queryKey: ["admin", "webhooks"] });
        setSecret(s);
      }} /> : null}
      {secret ? <SecretDialog title="Signing secret" secret={secret} note="Your endpoint uses this to check that deliveries come from this workspace. You can reveal or rotate it later." onClose={() => setSecret(null)} /> : null}
    </>
  );
}

/** Registering a webhook sends record data to that address, so the URL must be typed twice, exactly. */
function CreateWebhookDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (secret: string) => void }) {
  const api = useApi();
  const [url, setUrl] = useState("");
  const [confirm, setConfirm] = useState("");
  const [events, setEvents] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const matches = url.trim() !== "" && url.trim() === confirm.trim();
  const create = useMutation({
    // The answer holds the signing secret: never kept in the mutation cache once the dialog is gone.
    gcTime: 0,
    mutationFn: () => api.post<{ data: Webhook & { secret: string } }>("/v1/webhooks", {
      url: url.trim(), ...(description.trim() ? { description: description.trim() } : {}), events: events.split(/[\s,]+/).filter(Boolean),
    }),
    onSuccess: (r) => onCreated(r.data.secret),
    onError: (e) => setError(asProblem(e).detail),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="New webhook" description="Deliveries carry record data to this address. Only https:// on public addresses is allowed."
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" type="submit" form="new-webhook" busy={create.isPending} disabled={!matches}>Register webhook</Button></>}>
        <form id="new-webhook" className="grid gap-3.5" onSubmit={(e) => {
          e.preventDefault();
          if (matches) create.mutate();
        }}>
          {error ? <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-base text-danger-fg">{error}</p> : null}
          <FormField label="Endpoint URL" required>{(p) => <Input {...p} type="url" autoFocus placeholder="https://example.com/hooks/crm" value={url} onChange={(e) => setUrl(e.target.value)} />}</FormField>
          <FormField label="Type the URL again to confirm" required error={confirm && !matches ? "The two addresses don't match exactly" : null}>
            {(p) => <Input {...p} type="url" autoComplete="off" onPaste={(e) => e.preventDefault()} value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
          </FormField>
          <FormField label="Events" hint="Separated by commas: deal.*, contact.created, *.archived. Empty: only automations send to it.">{(p) => <Input {...p} value={events} onChange={(e) => setEvents(e.target.value)} />}</FormField>
          <FormField label="Description">{(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} />}</FormField>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WebhookDetail() {
  const { webhookId } = useParams({ strict: false }) as { webhookId?: string };
  const id = webhookId ?? "";
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const hook = useAdmin<{ data: Webhook }>(["webhook", id], `/v1/webhooks/${encodeURIComponent(id)}`);
  const deliveries = useAdmin<{ data: Delivery[] }>(["deliveries", id], `/v1/webhooks/${encodeURIComponent(id)}/deliveries`, { limit: 50 });
  const [deleting, setDeleting] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin"] });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.patch(`/v1/webhooks/${encodeURIComponent(id)}`, { enabled }),
    onSuccess: () => void refresh(),
    onError: (e) => toast.error(e, "Couldn't change the webhook"),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ data: { delivery: Delivery } }>(`/v1/webhooks/${encodeURIComponent(id)}/test`),
    onSuccess: () => {
      toast.toast({ tone: "info", title: "Test event queued", description: "It is sent within a few seconds; the result appears in the deliveries below." });
      setTimeout(() => void qc.invalidateQueries({ queryKey: ["admin", "deliveries", id] }), 2500);
    },
    onError: (e) => toast.error(e, "Couldn't send a test"),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/v1/webhooks/${encodeURIComponent(id)}`),
    onSuccess: () => {
      void refresh();
      toast.toast({ tone: "success", title: "Webhook archived" });
      void navigate({ to: "/settings/webhooks" });
    },
    onError: (e) => toast.error(e),
  });
  if (hook.error) return <ProblemView error={hook.error} />;
  if (!hook.data) return <Skeleton className="h-64 max-w-4xl" />;
  const w = hook.data.data;
  return (
    <>
      <Link to="/settings/webhooks" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="size-3.5" /> Webhooks</Link>
      <Section title="Webhook" description={<span className="break-all font-mono">{w.url}</span>}
        actions={<><Button size="sm" busy={test.isPending} onClick={() => test.mutate()}><Send /> Send test</Button><Button size="sm" variant="danger-ghost" onClick={() => setDeleting(true)}><Trash2 /> Archive…</Button></>}>
        <div className="grid gap-3 sm:grid-cols-3">
          <div><p className="text-sm text-muted">Status</p><Badge tone={statusTone(w.status)}>{String(w.status)}</Badge></div>
          <div><p className="text-sm text-muted">Events</p><p className="text-base">{w.events.length ? w.events.join(", ") : "Automations only"}</p></div>
          <label className="flex items-center gap-2 text-base"><Switch checked={w.enabled} onCheckedChange={(v) => toggle.mutate(v)} aria-label="Enabled" /> Enabled</label>
          {w.description ? <p className="text-base sm:col-span-3">{w.description}</p> : null}
          {typeof w.consecutive_failures === "number" && w.consecutive_failures > 0 ? <p className="text-sm text-warning-fg sm:col-span-3">{w.consecutive_failures} failures in a row{w.paused_until ? `; paused until ${formatDateTime(w.paused_until)}` : ""}.</p> : null}
        </div>
      </Section>
      <Section title="Recent deliveries" actions={<Button size="sm" variant="ghost" onClick={() => void deliveries.refetch()}>Refresh</Button>}>
        {deliveries.isPending ? <Skeleton className="h-20" /> : deliveries.error ? <ProblemView error={deliveries.error} compact /> : deliveries.data.data.length === 0 ? <p className="text-base text-muted">Nothing sent yet.</p> : (
          <SimpleTable label="Deliveries" head={["Event", "Status", "Attempts", "Result", "When"]}>
            {deliveries.data.data.map((d) => (
              <tr key={d.id}>
                <td className="px-4 py-2 font-mono text-sm">{String(d.event_type ?? "")}{d.trigger === "test" ? <Badge className="ml-2">test</Badge> : null}</td>
                <td className="px-4 py-2"><Badge tone={statusTone(d.status)}>{d.status}</Badge></td>
                <td className="px-4 py-2 tabular">{d.attempts}</td>
                <td className="px-4 py-2 text-sm">{d.last_status_code ? `HTTP ${String(d.last_status_code)}` : ""} {d.last_error ?? ""}</td>
                <td className="px-4 py-2 text-sm">{formatRelative(String(d.created_at ?? ""))}</td>
              </tr>
            ))}
          </SimpleTable>
        )}
      </Section>
      <ConfirmDialog open={deleting} onOpenChange={setDeleting} danger busy={remove.isPending} confirmLabel="Archive webhook" title="Archive this webhook?"
        description="It stops receiving events, and deliveries waiting to be sent are dropped." onConfirm={() => remove.mutate()} />
    </>
  );
}
