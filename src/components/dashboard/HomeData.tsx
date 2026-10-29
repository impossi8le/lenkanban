import { cache } from "react";
import Link from "next/link";
import { ArrowRight, Flame, Wrench } from "lucide-react";
import { RequestDialogLink } from "@/components/task/RequestDialogProvider";
import { prisma } from "@/lib/prisma";
import { requireDbUser } from "@/lib/require-user";
import { getTaskReadWhere } from "@/lib/project-access";
import { taskListVisibilityWhere } from "@/lib/task-list-visibility";
import { classifyDirectionName } from "@/lib/request-directions";

const labels: Record<string, string> = { DRAFT: "Черновик", SUBMITTED: "Новые", IN_PROGRESS: "В работе", NEEDS_INFO: "Ждём сотрудника", COMPLETED: "Решено", CANCELLED: "Отменено", CLOSED: "Закрыто", TODO: "Новые", IN_REVIEW: "Решено", DONE: "Решено" };

const readHomeData = cache(async () => {
  const user = await requireDbUser();
  const taskScope = { AND: [await getTaskReadWhere(user), taskListVisibilityWhere()] };
  const mine = { OR: [{ request: { authorId: user.id } }, { request: null, createdById: user.id }] };
  const [activeCount, replyCount, recent] = await Promise.all([
    prisma.task.count({ where: { AND: [taskScope, mine, { OR: [{ request: { state: { in: ["SUBMITTED", "IN_PROGRESS", "NEEDS_INFO"] } } }, { request: null, status: { not: "DONE" } }] }] } }),
    prisma.task.count({ where: { AND: [taskScope, { request: { authorId: user.id, state: "NEEDS_INFO" } }] } }),
    prisma.task.findMany({ where: taskScope, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 4, select: { id: true, title: true, projectId: true, status: true, column: { select: { name: true } }, project: { select: { name: true } }, request: { select: { state: true, executor: { select: { name: true } } } }, assignees: { take: 1, select: { user: { select: { name: true } } } } } }),
  ]);
  return { activeCount, replyCount, recent };
});

export async function HomeActiveCount() {
 const { activeCount } = await readHomeData();
 return <strong>{activeCount}</strong>;
}

export async function HomeReplyBanner() {
 const { replyCount } = await readHomeData();
 return replyCount > 0 ? <section className="home-reply-banner" aria-label="Обращения ждут ответа"><div><strong>{replyCount} {replyCount === 1 ? "обращение ждёт" : "обращения ждут"} вашего ответа</strong><p>Коллеге нужны подробности, чтобы продолжить работу.</p></div><Link href="/my-tasks?scope=reply" className="inline-flex min-h-11 items-center gap-2 rounded-lg border bg-background px-4 font-semibold">Ответить <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link></section> : null;
}

export async function HomeRecentRequests() {
 const { recent } = await readHomeData();
 return <div className="min-h-64">
      {recent.map(task => { const state = task.request?.state ?? task.status; const executor = task.request ? task.request.executor?.name : task.assignees[0]?.user.name; const claim = classifyDirectionName(task.project.name) === "claim"; return <RequestDialogLink key={task.id} projectId={task.projectId} taskId={task.id} className="home-request-row"><span className={`home-request-icon${claim ? " home-request-icon--claim" : ""}`}>{claim ? <Flame className="h-5 w-5" aria-hidden="true" /> : <Wrench className="h-5 w-5" aria-hidden="true" />}</span><div className="home-request-text"><strong>{task.title}</strong><p>{task.project.name} · {executor ? `Исполнитель: ${executor}` : "Ждёт специалиста"}</p></div><span className={`home-request-status home-request-status--${labels[state] ? state.toLowerCase() : "unknown"}`}>{labels[state] ?? (task.column?.name && !task.column.name.startsWith("COLUMN_") ? task.column.name : "В обработке")}</span></RequestDialogLink>; })}
      {recent.length === 0 && <p className="p-8 text-center text-muted-foreground">Здесь появятся ваши обращения</p>}
 </div>;
}
