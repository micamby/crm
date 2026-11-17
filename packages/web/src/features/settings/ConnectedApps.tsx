import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plug, Unplug } from "lucide-react";
import { useState } from "react";
import { EmptyState, ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/misc";
import { ConfirmDialog } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import type { ConnectedApp, OAuthScope } from "@/lib/api/types";
import { formatDateTime, formatRelative } from "@/lib/format";
import { SimpleTable, useAdmin } from "./SettingsLayout";

/**
 * Apps connected over OAuth to the MCP servers (ADR 0010; docs/mcp/oauth.md): one row per approved
 * connection (a grant). A member sees and disconnects their own (GET and DELETE /v1/auth/apps, browser
 * session only); an admin with members:manage sees and disconnects a member's (/v1/apps?member=).
 */

export const SCOPE_LABELS: Record<OAuthScope, string> = {
  "ops:read": "Read records",
  "ops:write": "Change records",
  "restricted:read": "See restricted fields",
  admin: "Change the setup (admin)",
};
export const ALL_SCOPES = Object.keys(SCOPE_LABELS) as OAuthScope[];

const scopeLabel = (s: string) => SCOPE_LABELS[s as OAuthScope] ?? s;

/** "ops" or "admin" from a resource URL (…/mcp/ops), else the URL itself. */
export function endpointOf(resource: string): string {
  const m = /\/mcp\/(ops|admin)\/?$/.exec(resource);
  return m ? (m[1] === "admin" ? "Admin MCP server" : "Ops MCP server") : resource;
}

/** The table of apps, with a confirmed Disconnect per row. `listKey`/`listPath` choose whose apps; `revokePath` how to disconnect. */
export function AppsList({ listKey, listPath, query, revokePath, whose, emptyText }: {
  listKey: unknown[]; listPath: string; query?: Record<string, string>; revokePath: (id: string) => string; whose: string; emptyText: string;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useAdmin<{ data: ConnectedApp[] }>(listKey, listPath, query);
  const [confirming, setConfirming] = useState<ConnectedApp | null>(null);
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete<{ data: { id: string; revoked: boolean } }>(revokePath(id)),
    onSuccess: (_r, id) => {
      // Drop it from the list at once, then refetch: the tokens stopped working server-side already.
      qc.setQueryData<{ data: ConnectedApp[] }>(["admin", ...listKey, query ?? {}], (old) => (old ? { data: old.data.filter((a) => a.id !== id) } : old));
      void qc.invalidateQueries({ queryKey: ["admin", ...listKey] });
      setConfirming(null);
      toast.toast({ tone: "success", title: "App disconnected", description: "Its access stopped at once. It can be connected again by approving it again." });
    },
    onError: (e) => {
      setConfirming(null);
      toast.error(e, "Couldn't disconnect the app");
    },
  });
  if (q.isPending) return <Skeleton className="h-16" />;
  if (q.error) return <ProblemView error={q.error} onRetry={() => q.refetch()} compact />;
  const apps = q.data.data;
  if (apps.length === 0) return <EmptyState icon={<Plug />} title="No connected apps" className="py-6">{emptyText}</EmptyState>;
  return (
    <>
      <SimpleTable label={`${whose} connected apps`} head={["App", "Access", "Connected", "Last used", ""]}>
        {apps.map((a) => (
          <tr key={a.id}>
            <td className="px-4 py-2">
              <p className="font-medium">{a.client.name}</p>
              <p className="text-sm text-muted">
                Returns to {a.client.redirect_host}
                {a.client.kind === "registered" ? <> · <Badge tone="warning" title="The app registered itself; its name isn't verified">unverified name</Badge></> : a.client.verified_by_document ? <> · <Badge tone="success">verified</Badge></> : null}
              </p>
            </td>
            <td className="px-4 py-2 text-sm">
              <p>{endpointOf(a.resource)}</p>
              <p className="text-muted">{a.scopes.map(scopeLabel).join(", ") || "No scopes"}</p>
            </td>
            <td className="px-4 py-2 text-sm"><span title={formatDateTime(a.created_at)}>{formatRelative(a.created_at)}</span><span className="block text-subtle">until {formatDateTime(a.expires_at)}</span></td>
            <td className="px-4 py-2 text-sm">{a.last_used_at ? formatRelative(a.last_used_at) : "Never"}</td>
            <td className="px-4 py-2 text-right"><Button size="sm" variant="danger-ghost" onClick={() => setConfirming(a)} aria-label={`Disconnect ${a.client.name}`}><Unplug /> Disconnect</Button></td>
          </tr>
        ))}
      </SimpleTable>
      <ConfirmDialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)} danger busy={revoke.isPending} confirmLabel="Disconnect"
        title={`Disconnect ${confirming?.client.name ?? "this app"}?`}
        description={`Its access and refresh tokens stop working at once (${confirming ? endpointOf(confirming.resource) : ""}). The app has to be approved again to reconnect.`}
        onConfirm={() => confirming && revoke.mutate(confirming.id)} />
    </>
  );
}
