import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Package, Pause, Play, Zap } from "lucide-react";
import { EmptyState, ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import type { Automation, AutomationRun, InstalledPack } from "@/lib/api/types";
import { formatDateTime, formatRelative } from "@/lib/format";
import { DocsLink } from "@/lib/docs";
import { useSession } from "@/lib/session";
import { Section, SimpleTable, useAdmin } from "./SettingsLayout";

/**
 * Read-only views of two server features that have no editor in the app yet: automations (with pause
 * and resume) and installed schema packs. Creating and changing either is done with the `crm` CLI, the
 * API or the admin MCP server (docs/automations.md, docs/packs.md).
 */


/** A trigger in a few words: "When deal.created", "On a schedule", "Run by hand". */
/** What happened to a record, for an event's name ("deal.created" → "a deal is created"). */
const EVENT_VERBS: Record<string, string> = {
  created: "is created", updated: "is changed", archived: "is archived", restored: "is restored", deleted: "is deleted", merged: "is merged",
  stage_changed: "changes stage", won: "is won", lost: "is lost", converted: "is converted", assigned: "is assigned", completed: "is completed",
};
export function describeEvent(event: string): string {
  const [object, verb] = event.split(".", 2);
  const words = verb ? EVENT_VERBS[verb] : undefined;
  if (!object || !words) return event;
  const thing = object.replaceAll("_", " ");
  return `${/^[aeiou]/.test(thing) ? "an" : "a"} ${thing} ${words}`;
}

export function describeTrigger(t: Automation["trigger"]): string {
  if (t.type === "event") {
    if (typeof t.event !== "string") return "When an event happens";
    const words = describeEvent(t.event);
    return words === t.event ? `When ${t.event}` : `When ${words} (${t.event})`;
  }
  if (t.type === "schedule") return "On a schedule";
  if (t.type === "manual") return typeof t.object === "string" ? `Run by hand on ${t.object} records` : "Run by hand";
  return String(t.type ?? "Unknown trigger");
}

const STATUS_TONE = { enabled: "success", paused: "warning", disabled: "neutral", archived: "neutral" } as const;
const RUN_TONE = { succeeded: "success", failed: "danger", skipped: "warning", queued: "neutral", running: "accent" } as const;

export function AutomationsSettings() {
  const s = useSession();
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const list = useAdmin<{ data: Automation[] }>(["automations"], "/v1/automations");
  const settings = useAdmin<{ data: { paused: boolean; paused_reason: string | null } }>(["automation-settings"], "/v1/automation-settings");
  const manage = s.can("automations:manage");
  const toggle = useMutation({
    mutationFn: ({ a, pause }: { a: Automation; pause: boolean }) =>
      api.post<{ data: Automation }>(`/v1/automations/${encodeURIComponent(a.id)}/${pause ? "pause" : "resume"}`, pause ? { reason: "Paused from the web app" } : undefined),
    onSuccess: (r, v) => {
      qc.setQueryData<{ data: Automation[] }>(["admin", "automations", {}], (old) => (old ? { data: old.data.map((x) => (x.id === r.data.id ? { ...x, ...r.data } : x)) } : old));
      void qc.invalidateQueries({ queryKey: ["admin", "automations"] });
      toast.toast({ tone: "success", title: v.pause ? `${v.a.name} paused` : `${v.a.name} resumed` });
    },
    onError: (e) => toast.error(e, "Couldn't change the automation"),
  });
  const shown = (list.data?.data ?? []).filter((a) => a.status !== "archived");
  return (
    <Section title="Automations" description={<>
      Rules that act on events, on a schedule or on request. Create and edit them with the <code>crm automations</code> command-line tool, the API or the admin MCP server;
      the <DocsLink page="automations.md">automations guide</DocsLink> shows how.
    </>}>
      {settings.data?.data.paused ? (
        <p role="status" className="mb-3 rounded-md border border-line bg-warning-soft px-3 py-2 text-base text-warning-fg">
          Every automation in this workspace is paused{settings.data.data.paused_reason ? `: ${settings.data.data.paused_reason}` : ""}.
        </p>
      ) : null}
      {list.isPending ? <Skeleton className="h-24" /> : list.error ? <ProblemView error={list.error} onRetry={() => list.refetch()} compact /> : shown.length === 0 ? (
        <EmptyState icon={<Zap />} title="No automations yet" className="py-6">
          An automation does something for you when a record changes or on a schedule, such as notifying an owner about a big deal. The <DocsLink page="automations.md">automations guide</DocsLink> walks you through creating the first one.
        </EmptyState>
      ) : (
        <SimpleTable label="Automations" head={["Automation", "Trigger", "State", "Last run", ""]}>
          {shown.map((a) => (
            <tr key={a.id}>
              <td className="px-4 py-2"><p className="font-medium">{a.name}</p>{a.description ? <p className="text-sm text-muted">{a.description}</p> : null}</td>
              <td className="px-4 py-2 text-sm">{describeTrigger(a.trigger)}{a.next_run_at ? <span className="block text-subtle">next {formatDateTime(a.next_run_at)}</span> : null}</td>
              <td className="px-4 py-2 text-sm">
                <Badge tone={STATUS_TONE[a.status] ?? "neutral"}>{a.status.charAt(0).toUpperCase() + a.status.slice(1)}</Badge>
                {a.status === "paused" && a.paused_reason ? <span className="block text-muted">{a.paused_reason}</span> : null}
              </td>
              <td className="px-4 py-2 text-sm"><LastRun id={a.id} /></td>
              <td className="px-4 py-2 text-right">
                {manage && a.status === "enabled" ? <Button size="sm" variant="ghost" busy={toggle.isPending && toggle.variables?.a.id === a.id} onClick={() => toggle.mutate({ a, pause: true })} aria-label={`Pause ${a.name}`}><Pause /> Pause</Button> : null}
                {manage && a.status === "paused" ? <Button size="sm" busy={toggle.isPending && toggle.variables?.a.id === a.id} onClick={() => toggle.mutate({ a, pause: false })} aria-label={`Resume ${a.name}`}><Play /> Resume</Button> : null}
              </td>
            </tr>
          ))}
        </SimpleTable>
      )}
    </Section>
  );
}

function LastRun({ id }: { id: string }) {
  const q = useAdmin<{ data: AutomationRun[] }>(["automation-runs", id], `/v1/automations/${encodeURIComponent(id)}/runs`, { limit: 1 });
  if (q.isPending) return <Skeleton className="h-4 w-20" />;
  if (q.error) return <span className="text-muted">Unavailable</span>;
  const r = q.data.data[0];
  if (!r) return <span className="text-muted">Never run</span>;
  return (
    <span title={[r.reason, r.cap ? `cap: ${r.cap}` : null, r.failure ? `failure: ${r.failure}` : null].filter(Boolean).join(" · ") || undefined}>
      <Badge tone={RUN_TONE[r.status] ?? "neutral"}>{r.status}</Badge> <span className="text-muted">{formatRelative(r.finished_at ?? r.started_at)}</span>
    </span>
  );
}

export function PacksSettings() {
  const q = useAdmin<{ data: InstalledPack[] }>(["packs"], "/v1/packs");
  return (
    <Section title="Installed packs" description={<>
      Schema packs set a workspace up for a use case (objects, fields, pipelines, roles, views). Install, upgrade and uninstall them with the <code>crm pack</code> CLI or
      the API (see the <DocsLink page="packs.md">packs guide</DocsLink>); connected apps can only plan and list them.
    </>}>
      {q.isPending ? <Skeleton className="h-16" /> : q.error ? <ProblemView error={q.error} onRetry={() => q.refetch()} compact /> : q.data.data.length === 0 ? (
        <EmptyState icon={<Package />} title="No packs installed" className="py-6">Try <code>crm pack install packs/recruiting</code>.</EmptyState>
      ) : (
        <SimpleTable label="Installed packs" head={["Pack", "Version", "State", "Adds", "Updated"]}>
          {q.data.data.map((p) => (
            <tr key={p.name}>
              <td className="px-4 py-2"><p className="font-medium">{p.name}</p>{p.description ? <p className="text-sm text-muted">{p.description}</p> : null}</td>
              <td className="px-4 py-2 text-sm">{p.version}</td>
              <td className="px-4 py-2 text-sm">{p.status === "installed" ? <Badge tone="success">Installed</Badge> : <Badge>Uninstalled</Badge>}</td>
              <td className="px-4 py-2 text-sm text-muted">{owns(p)}</td>
              <td className="px-4 py-2 text-sm" title={formatDateTime(p.updated_at)}>{formatRelative(p.updated_at)}</td>
            </tr>
          ))}
        </SimpleTable>
      )}
    </Section>
  );
}

function owns(p: InstalledPack): string {
  const o = p.owns ?? { objects: [], fields: [], pipelines: [], roles: [], views: [] };
  const part = (n: number, what: string) => (n ? `${n} ${what}${n === 1 ? "" : "s"}` : null);
  return [part(o.objects?.length ?? 0, "object"), part(o.fields?.length ?? 0, "field"), part(o.pipelines?.length ?? 0, "pipeline"),
    part(o.roles?.length ?? 0, "role"), part(o.views?.length ?? 0, "view")].filter(Boolean).join(", ") || "Nothing";
}
