import { Link } from "@tanstack/react-router";
import { ArrowRight, Bell, ListChecks } from "lucide-react";
import { ProblemView } from "@/components/feedback";
import { Skeleton } from "@/components/ui/misc";
import { NotificationRow, TaskItem, useAttention, useMyTasks } from "@/features/inbox/shared";
import { SetPasswordCard } from "@/features/shell/FirstRun";
import { useSession } from "@/lib/session";
import { isJunction, navObjects, useObjects } from "@/meta/hooks";
import { ObjectIcon } from "@/meta/icons";

function greeting(d = new Date()): string {
  const h = d.getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** A starting point: what needs attention, what's on my list, and every object a click away. */
export function HomePage() {
  const s = useSession();
  const attention = useAttention();
  const tasks = useMyTasks();
  const objects = useObjects();
  const { standard, custom } = navObjects(objects.data ?? []);
  const first = s.member.name.split(/\s+/)[0];
  return (
    <div className="mx-auto max-w-5xl p-4 md:p-8">
      <h1 className="text-2xl font-semibold">{greeting()}, {first}</h1>
      <p className="mt-1 text-base text-muted">{s.workspace.name}</p>
      <SetPasswordCard />
      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <section aria-labelledby="h-attention" className="rounded-lg border border-line bg-surface">
          <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <Bell className="size-4 text-muted" aria-hidden />
            <h2 id="h-attention" className="flex-1 text-md font-semibold">Needs attention</h2>
            <Link to="/inbox" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">Inbox <ArrowRight className="size-3.5" /></Link>
          </header>
          {attention.isPending ? <div className="p-4"><Skeleton className="h-10" /></div>
            : attention.error ? <div className="p-4"><ProblemView error={attention.error} compact /></div>
            : attention.data.items.length === 0 ? <p className="px-4 py-6 text-base text-muted">Nothing needs your attention right now.</p>
            : <ul className="divide-y divide-line">{attention.data.items.slice(0, 5).map((n) => <NotificationRow key={n.id} n={n} />)}</ul>}
        </section>
        <section aria-labelledby="h-tasks" className="rounded-lg border border-line bg-surface">
          <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <ListChecks className="size-4 text-muted" aria-hidden />
            <h2 id="h-tasks" className="flex-1 text-md font-semibold">My tasks</h2>
            <Link to="/tasks" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">All tasks <ArrowRight className="size-3.5" /></Link>
          </header>
          {tasks.isPending ? <div className="p-4"><Skeleton className="h-10" /></div>
            : tasks.error ? <div className="p-4"><ProblemView error={tasks.error} compact /></div>
            : tasks.data.length === 0 ? <p className="px-4 py-6 text-base text-muted">No open tasks. Enjoy it.</p>
            : <ul className="divide-y divide-line">{tasks.data.slice(0, 6).map((t) => <TaskItem key={t.id} task={t} overdue={typeof t.due_at === "string" && new Date(t.due_at).getTime() < Date.now()} />)}</ul>}
        </section>
      </div>
      <section aria-labelledby="h-objects" className="mt-6">
        <h2 id="h-objects" className="mb-3 text-md font-semibold">Records</h2>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {objects.isPending ? [1, 2, 3, 4].map((i) => <li key={i}><Skeleton className="h-16" /></li>) : [...standard.filter((o) => !isJunction(o)), ...custom].map((o) => (
            <li key={o.name}>
              <Link to="/o/$object" params={{ object: o.name }} search={{}} className="flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 hover:border-line-strong hover:bg-surface-2">
                <span className="rounded-md bg-accent-soft p-1.5 text-accent-soft-fg"><ObjectIcon object={o} /></span>
                <span className="min-w-0 truncate font-medium">{o.plural_label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
