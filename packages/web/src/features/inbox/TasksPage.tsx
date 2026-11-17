import { ListChecks, Plus } from "lucide-react";
import { useState } from "react";
import { EmptyState, PageHeader, ProblemView } from "@/components/feedback";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { CreateRecordDialog } from "@/features/create/CreateRecordDialog";
import type { RecordData } from "@/lib/api/types";
import { useObjects } from "@/meta/hooks";
import { TaskItem, useMyTasks } from "./shared";

/** Open tasks assigned to me, grouped by when they are due. */
export function TasksPage() {
  const tasks = useMyTasks();
  const objects = useObjects();
  const [creating, setCreating] = useState(false);
  const canCreate = Boolean(objects.data?.find((o) => o.name === "task")?.access.write);
  const groups = groupTasks(tasks.data ?? []);
  return (
    <div>
      <PageHeader icon={<ListChecks />} title="My tasks" subtitle="Open tasks assigned to you"
        actions={canCreate ? <Button variant="primary" onClick={() => setCreating(true)}><Plus /> New task</Button> : null} />
      <div className="mx-auto max-w-3xl p-4 md:p-6">
        {tasks.isPending ? <div className="flex flex-col gap-3" aria-busy="true">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12" />)}</div>
          : tasks.error ? <ProblemView error={tasks.error} onRetry={() => tasks.refetch()} />
          : tasks.data.length === 0 ? <EmptyState icon={<ListChecks />} title="Nothing on your list">Tasks assigned to you show up here, soonest first.</EmptyState>
          : groups.map(([label, list, overdue]) => list.length ? (
            <section key={label} aria-label={label} className="mb-5 rounded-lg border border-line bg-surface">
              <h2 className="border-b border-line px-4 py-2 text-base font-semibold">{label} <span className="font-normal text-subtle">{list.length}</span></h2>
              <ul className="divide-y divide-line">{list.map((t) => <TaskItem key={t.id} task={t} overdue={overdue} />)}</ul>
            </section>
          ) : null)}
      </div>
      {creating ? <CreateRecordDialog object="task" open onOpenChange={setCreating} stay /> : null}
    </div>
  );
}

export function groupTasks(tasks: RecordData[], now = new Date()): [string, RecordData[], boolean][] {
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  const due = (t: RecordData) => (typeof t.due_at === "string" ? new Date(t.due_at).getTime() : null);
  return [
    ["Overdue", tasks.filter((t) => due(t) !== null && due(t)! < now.getTime()), true],
    ["Today", tasks.filter((t) => due(t) !== null && due(t)! >= now.getTime() && due(t)! <= endOfToday.getTime()), false],
    ["Upcoming", tasks.filter((t) => due(t) !== null && due(t)! > endOfToday.getTime()), false],
    ["No due date", tasks.filter((t) => due(t) === null), false],
  ];
}
