import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, AlertOctagon, AlertTriangle, Check, CheckCheck, Info, Square, CheckSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/overlays";
import { useToast } from "@/components/ui/toast";
import { useApi } from "@/lib/api/context";
import type { Attention, NotificationItem, RecordData, Severity } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { formatDateTime, formatRelative } from "@/lib/format";
import { qk } from "@/lib/keys";
import { touchedBy, useApplyWrite } from "@/lib/writes";
import { useDescribe } from "@/meta/hooks";
import { RecordLink } from "@/meta/registry";

export function useAttention() {
  const api = useApi();
  return useQuery({
    queryKey: qk.attention,
    queryFn: async ({ signal }) => (await api.get<{ data: Attention }>("/v1/me/attention", undefined, signal)).data,
    refetchOnWindowFocus: true,
  });
}

export function useMyTasks() {
  const api = useApi();
  return useQuery({
    queryKey: qk.myTasks,
    queryFn: async ({ signal }) => (await api.get<{ data: RecordData[] }>("/v1/me/tasks", undefined, signal)).data,
  });
}

export const SEVERITY: Record<Severity, { label: string; tone: "danger" | "warning" | "info"; Icon: typeof Info }> = {
  critical: { label: "Critical", tone: "danger", Icon: AlertOctagon },
  warning: { label: "Warning", tone: "warning", Icon: AlertTriangle },
  info: { label: "Info", tone: "info", Icon: Info },
};

function nextMorning(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

/** One notification with its actions: acknowledge, snooze, resolve. */
export function NotificationRow({ n }: { n: NotificationItem }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const act = useMutation({
    mutationFn: ({ action, until }: { action: "acknowledge" | "resolve" | "snooze"; until?: string }) =>
      api.post(`/v1/me/notifications/${encodeURIComponent(n.id)}/${action}`, until ? { until } : undefined),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ["inbox"] });
      toast.toast({ tone: "success", title: v.action === "resolve" ? "Resolved" : v.action === "snooze" ? "Snoozed" : "Marked as seen" });
    },
    onError: (e) => toast.error(e, "Couldn't update the notification"),
  });
  const s = SEVERITY[n.severity];
  const open = n.state !== "resolved";
  return (
    <li className={cn("flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start", n.state === "unread" && "bg-accent-soft/40")}>
      <s.Icon aria-hidden className={cn("mt-0.5 hidden size-4 shrink-0 sm:block", s.tone === "danger" ? "text-danger" : s.tone === "warning" ? "text-warning" : "text-info")} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <Badge tone={s.tone}>{s.label}</Badge>
          <span className={cn("text-base", n.state === "unread" && "font-semibold")}>{n.title}</span>
          {n.state === "unread" ? <span className="sr-only">(unread)</span> : null}
        </p>
        {n.body ? <p className="mt-1 whitespace-pre-wrap break-words text-base text-muted">{n.body}</p> : null}
        <p className="mt-1 flex flex-wrap gap-x-2 text-sm text-subtle">
          {n.record && n.record.display_name !== "(not available)" ? <RecordLink object={n.record.object} id={n.record.id}>{n.record.display_name}</RecordLink> : null}
          <span title={formatDateTime(n.last_fired_at)}>{formatRelative(n.last_fired_at)}</span>
          {n.source.name ? <span>· {n.source.type === "alert" ? "Alert" : "Automation"}: {n.source.name}</span> : null}
          {n.fire_count > 1 ? <span>· fired {n.fire_count} times</span> : null}
          {n.state === "snoozed" && n.snoozed_until ? <span>· snoozed until {formatDateTime(n.snoozed_until)}</span> : null}
          {n.state === "resolved" ? <span>· resolved</span> : null}
        </p>
      </div>
      {open ? (
        <div className="flex shrink-0 gap-1.5">
          {n.state === "unread" ? <Button size="sm" variant="ghost" busy={act.isPending && act.variables?.action === "acknowledge"} onClick={() => act.mutate({ action: "acknowledge" })}><Check /> Seen</Button> : null}
          <Menu>
            <MenuTrigger asChild><Button size="sm" variant="ghost"><AlarmClock /> Snooze</Button></MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => act.mutate({ action: "snooze", until: new Date(Date.now() + 3_600_000).toISOString() })}>For an hour</MenuItem>
              <MenuItem onSelect={() => act.mutate({ action: "snooze", until: nextMorning(1) })}>Until tomorrow, 9:00</MenuItem>
              <MenuItem onSelect={() => act.mutate({ action: "snooze", until: nextMorning(7) })}>For a week</MenuItem>
            </MenuContent>
          </Menu>
          <Button size="sm" busy={act.isPending && act.variables?.action === "resolve"} onClick={() => act.mutate({ action: "resolve" })}><CheckCheck /> Resolve</Button>
        </div>
      ) : null}
    </li>
  );
}

/** A task with a box to tick it off (the status moves to its "done" value). */
export function TaskItem({ task, overdue }: { task: RecordData; overdue?: boolean }) {
  const api = useApi();
  const applyWrite = useApplyWrite();
  const toast = useToast();
  const meta = useDescribe("task");
  const status = meta.data?.fields.find((f) => f.name === "status");
  const doneKey = status?.values?.find((v) => v.category === "done")?.key;
  const done = useMutation({
    mutationFn: () => api.patch<{ data: RecordData }>(`/v1/objects/task/records/${encodeURIComponent(task.id)}`, { status: doneKey }, { ifMatch: task.version }),
    onSuccess: (r) => {
      // The task leaves "my tasks" and the inbox's overdue list, and its related records' timelines update.
      applyWrite({ object: "task", id: task.id, record: r.data, touched: touchedBy(task) });
      toast.toast({ tone: "success", title: "Task done", description: task.display_name });
    },
    onError: (e) => toast.error(e, "Couldn't complete the task"),
  });
  const canTick = Boolean(meta.data?.access.write && status?.access === "write" && doneKey);
  return (
    <li className="flex items-start gap-3 px-4 py-2.5">
      {canTick ? (
        <button type="button" onClick={() => done.mutate()} disabled={done.isPending} aria-label={`Mark ${task.display_name} done`} className="mt-0.5 text-muted hover:text-accent">
          {done.isSuccess ? <CheckSquare className="size-4 text-success" /> : <Square className="size-4" />}
        </button>
      ) : null}
      <div className="min-w-0 flex-1">
        <RecordLink object="task" id={task.id} className="font-medium">{task.display_name || "Task"}</RecordLink>
        <p className="flex flex-wrap gap-x-2 text-sm text-subtle">
          {typeof task.due_at === "string" ? <span className={overdue ? "font-medium text-danger-fg" : ""}>Due {formatDateTime(task.due_at)}</span> : <span>No due date</span>}
          {typeof task.priority === "string" && task.priority !== "normal" ? <span>· {task.priority} priority</span> : null}
          {(task.related as { id: string; object: string | null; display_name: string | null }[] | undefined)?.filter((r) => r.object && r.display_name).slice(0, 2).map((r) => (
            <span key={r.id}>· <RecordLink object={r.object!} id={r.id}>{r.display_name}</RecordLink></span>
          ))}
        </p>
      </div>
    </li>
  );
}
