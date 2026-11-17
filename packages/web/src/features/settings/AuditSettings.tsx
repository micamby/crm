import { useInfiniteQuery } from "@tanstack/react-query";
import { Fragment, useMemo, useState } from "react";
import { ProblemView } from "@/components/feedback";
import { useDebounced, useUsers } from "@/components/pickers";
import { Button } from "@/components/ui/button";
import { FormField, Input } from "@/components/ui/input";
import { Badge, Skeleton } from "@/components/ui/misc";
import { useApi } from "@/lib/api/context";
import type { AuditEntry, Members } from "@/lib/api/types";
import { formatDateTime } from "@/lib/format";
import { useSession } from "@/lib/session";
import { plainLabel } from "@/lib/text";
import { useObjects } from "@/meta/hooks";
import { actionLabel, actorLabel } from "./audit-labels";
import { Section, SimpleTable, useAdmin } from "./SettingsLayout";

const SURFACES: Record<string, string> = { web: "Web app", api: "API", cli: "CLI", "admin-mcp": "Admin MCP", "ops-mcp": "Ops MCP", system: "System" };

/** The tamper-evident audit log, newest first, filtered by action (a prefix: "member.", "auth.signed_in"). */
export function AuditSettings() {
  const api = useApi();
  const s = useSession();
  // Names for the actors: the members list where this member may read it, else the workspace directory.
  const members = useAdmin<{ data: Members }>(["members"], "/v1/members", undefined, s.can("members:manage"));
  const directory = useUsers("");
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of directory.data ?? []) m.set(u.id, u.name);
    for (const u of members.data?.data.users ?? []) m.set(u.id, u.name);
    for (const a of members.data?.data.service_accounts ?? []) m.set(a.id, a.name);
    return m;
  }, [directory.data, members.data]);
  const [action, setAction] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const prefix = useDebounced(action.trim(), 350);
  const q = useInfiniteQuery({
    queryKey: ["admin", "audit", prefix],
    queryFn: ({ pageParam, signal }) => api.get<{ data: AuditEntry[]; next_before: number | null }>("/v1/audit-log", { limit: 100, action: prefix || undefined, before: pageParam }, signal),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (p) => p.next_before ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  const objects = useObjects();
  const objectLabels = useMemo(() => new Map((objects.data ?? []).map((o) => [o.name, o.label])), [objects.data]);
  return (
    <Section title="Audit log" description="Every change, sign-in and administrative action, with who did it and from where. Entries hold field names, never values.">
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <FormField label="Action starts with" className="w-72">{(p) => <Input {...p} placeholder="e.g. member. or deal.stage_changed" value={action} onChange={(e) => setAction(e.target.value)} />}</FormField>
        {["auth.", "member.", "role.", "api_key.", "view."].map((a) => <Button key={a} size="sm" variant="ghost" onClick={() => setAction(a)}>{a}</Button>)}
      </div>
      {q.isPending ? <Skeleton className="h-40" /> : q.error ? <ProblemView error={q.error} compact /> : rows.length === 0 ? <p className="text-base text-muted">No entries match.</p> : (
        <SimpleTable label="Audit entries" head={["When", "What happened", "Who", "Through", "Object", <span key="d" className="sr-only">Details</span>]}>
          {rows.map((r) => (
            <Fragment key={r.seq}>
              <tr>
                <td className="whitespace-nowrap px-4 py-1.5 text-sm">{formatDateTime(r.at)}</td>
                <td className="px-4 py-1.5"><p className="text-sm">{actionLabel(r.action, r.object)}</p><code className="font-mono text-xs text-subtle">{r.action}</code></td>
                <td className="px-4 py-1.5 text-sm">{(() => {
                  const a = actorLabel(r.actor, names, s.member);
                  return <><p><bdi>{a.name}</bdi></p>{a.known ? null : <code className="font-mono text-xs text-subtle">{r.actor}</code>}</>;
                })()}</td>
                <td className="px-4 py-1.5"><Badge>{SURFACES[r.surface] ?? r.surface}</Badge></td>
                <td className="px-4 py-1.5 text-sm">{r.object ? plainLabel(objectLabels.get(r.object) ?? r.object) : ""}</td>
                <td className="px-4 py-1.5 text-right"><Button size="sm" variant="ghost" aria-expanded={open === r.seq} aria-label={`Details of entry ${r.seq}`} onClick={() => setOpen(open === r.seq ? null : r.seq)}>Details</Button></td>
              </tr>
              {open === r.seq ? (
                <tr><td colSpan={6} className="bg-surface-2 px-4 py-2">
                  <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs">{JSON.stringify({ seq: r.seq, key: r.key, record_id: r.record_id, request_id: r.request_id, sealed: r.sealed, details: r.details }, null, 2)}</pre>
                </td></tr>
              ) : null}
            </Fragment>
          ))}
        </SimpleTable>
      )}
      {q.hasNextPage ? <Button className="mt-6" size="sm" busy={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>Load older entries</Button> : null}
    </Section>
  );
}
