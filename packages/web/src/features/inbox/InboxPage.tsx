import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Bell, Inbox, Settings2 } from "lucide-react";
import { EmptyState, PageHeader, ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { useApi } from "@/lib/api/context";
import type { NotificationItem } from "@/lib/api/types";
import { cn } from "@/lib/cn";
import { qk } from "@/lib/keys";
import { inboxRoute } from "@/router";
import { NotificationRow, SEVERITY, TaskItem, useAttention } from "./shared";

const STATES = [["open", "Open"], ["unread", "Unread"], ["snoozed", "Snoozed"], ["resolved", "Resolved"], ["all", "All"]] as const;

/** What needs my attention: open alerts by severity and overdue tasks, then every notification by state. */
export function InboxPage() {
  const api = useApi();
  const navigate = useNavigate({ from: "/inbox" });
  const state = inboxRoute.useSearch().state ?? "open";
  const attention = useAttention();
  const list = useInfiniteQuery({
    queryKey: qk.notifications(state),
    queryFn: ({ pageParam, signal }) => api.get<{ data: NotificationItem[]; next_before: string | null }>("/v1/me/notifications", { state, limit: 50, before: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => p.next_before ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.data) ?? [];
  const c = attention.data?.counts;
  const overdue = attention.data?.overdue_tasks;
  return (
    <div>
      <PageHeader icon={<Bell />} title="Inbox" subtitle="Alerts and automation messages for you"
        actions={<Button asChild size="sm"><Link to="/settings/notifications"><Settings2 /> Email settings</Link></Button>} />
      <div className="mx-auto flex max-w-4xl flex-col gap-5 p-4 md:p-6">
        <section aria-label="Needs attention" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {(["critical", "warning", "info"] as const).map((sev) => {
            const S = SEVERITY[sev];
            return (
              <div key={sev} className="rounded-lg border border-line bg-surface px-4 py-3">
                <p className="flex items-center gap-1.5 text-sm text-muted"><S.Icon className="size-3.5" aria-hidden /> {S.label}</p>
                <p className="mt-1 text-2xl font-semibold tabular">{c ? c[sev] : <Skeleton className="h-6 w-8" />}</p>
              </div>
            );
          })}
          <div className="rounded-lg border border-line bg-surface px-4 py-3">
            <p className="text-sm text-muted">Overdue tasks</p>
            <p className="mt-1 text-2xl font-semibold tabular">{attention.isPending ? <Skeleton className="h-6 w-8" /> : overdue ? overdue.length : "—"}</p>
          </div>
        </section>
        {attention.data?.overdue_tasks_note ? <p className="text-sm text-subtle">{attention.data.overdue_tasks_note}</p> : null}
        {overdue && overdue.length ? (
          <section aria-label="Overdue tasks" className="rounded-lg border border-line bg-surface">
            <h2 className="border-b border-line px-4 py-2 text-base font-semibold">Overdue tasks</h2>
            <ul className="divide-y divide-line">{overdue.map((t) => <TaskItem key={t.id} task={{ id: t.id, object: "task", display_name: t.title ?? "Task", due_at: t.due_at, priority: t.priority }} overdue />)}</ul>
          </section>
        ) : null}
        <section aria-label="Notifications" className="rounded-lg border border-line bg-surface">
          <div className="flex flex-wrap gap-1 border-b border-line px-2 pt-1" role="tablist" aria-label="Notification state">
            {STATES.map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={state === key} onClick={() => void navigate({ search: key === "open" ? {} : { state: key }, replace: true })}
                className={cn("-mb-px border-b-2 px-3 py-2 text-base", state === key ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg")}>
                {label}{key === "unread" && c?.unread ? <span className="ml-1.5 rounded-full bg-accent px-1.5 text-xs text-accent-fg">{c.unread}</span> : null}
              </button>
            ))}
          </div>
          {list.isPending ? <div className="flex flex-col gap-3 p-4" aria-busy="true">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}</div>
            : list.error ? <div className="p-4"><ProblemView error={list.error} onRetry={() => list.refetch()} /></div>
            : items.length === 0 ? <EmptyState icon={<Inbox />} title={state === "open" ? "All clear" : "Nothing here"}>Alerts you set up, and automations that notify you, land here.</EmptyState>
            : <ul className="divide-y divide-line">{items.map((n) => <NotificationRow key={n.id} n={n} />)}</ul>}
          {list.hasNextPage ? <div className="border-t border-line p-2"><Button size="sm" variant="ghost" busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>Load older</Button></div> : null}
        </section>
      </div>
    </div>
  );
}
