import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireDbUser } from "@/lib/require-user";
import { getTaskReadWhere } from "@/lib/project-access";
import { managerQueues, managerQueueWhere, parseManagerFilters } from "@/features/kanban/model/manager-queues";

export default async function ManagerPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireDbUser();
  const params = await searchParams;
  let filters;
  try { filters = parseManagerFilters(params); }
  catch (error) {
    return <div className="p-6"><h1 className="text-2xl font-semibold">Очереди руководителя</h1>
      <p role="alert">{error instanceof Error ? error.message : "Некорректные фильтры"}</p>
      <Link href="/manager">Сбросить фильтры</Link></div>;
  }
  const where = await getTaskReadWhere(user, managerQueueWhere(filters, new Date()));
  const [tasks, total] = await Promise.all([
    prisma.task.findMany({ where, select: { id: true, title: true, projectId: true, deadline: true },
      orderBy: [{ deadline: { sort: "asc", nulls: "last" } }, { id: "asc" }], take: 100 }),
    prisma.task.count({ where }),
  ]);
  return <div className="h-full overflow-y-auto p-4 sm:p-6"><div className="mx-auto max-w-5xl space-y-6">
    <h1 className="text-2xl font-semibold">Очереди руководителя</h1>
    <form method="get" className="flex flex-wrap items-end gap-4">
      <label className="grid gap-1">Очередь<select name="queue" defaultValue={filters.queue} className="min-h-11 rounded border bg-background p-2">
        {Object.entries(managerQueues).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label className="grid gap-1">Срок с (UTC)<input type="date" name="from" defaultValue={filters.from} className="min-h-11 rounded border bg-background p-2" /></label>
      <label className="grid gap-1">Срок по (UTC, включительно)<input type="date" name="to" defaultValue={filters.to} className="min-h-11 rounded border bg-background p-2" /></label>
      <button className="min-h-11 rounded border px-4" type="submit">Показать</button>
      <Link href="/manager" className="inline-flex min-h-11 items-center underline">Сбросить</Link>
    </form>
    <p>Найдено: {total}{total > 100 ? ". Показаны первые 100; сузьте период." : ""}</p>
    {tasks.length === 0 ? <p>В этой очереди нет задач.</p> : <ul className="space-y-2">
      {tasks.map(task => <li key={task.id} className="rounded border p-3">
        <Link href={`/projects/${task.projectId}/board?task=${task.id}`} className="break-words underline">{task.title}</Link>
        <p className="text-sm text-muted-foreground">{task.deadline ? `Срок: ${task.deadline.toISOString().replace("T", " ").slice(0, 16)} UTC` : "Без срока"}</p>
      </li>)}
    </ul>}
  </div></div>;
}
