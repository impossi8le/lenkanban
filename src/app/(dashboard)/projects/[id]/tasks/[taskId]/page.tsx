import { requireDbUser } from "@/lib/require-user";
import { getTaskReadWhere } from "@/lib/project-access";
import { notFound } from "next/navigation";
import { TaskDetailPage } from "./TaskDetailPage";
import { prisma } from "@/lib/prisma";
import { taskDetailInclude } from "@/lib/task-detail-dto";
import { toTaskDetailForReader } from "@/lib/task-detail-for-reader";

export default async function TaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; taskId: string }>;
  searchParams: Promise<{ tab?: string; msg?: string }>;
}) {
  const resolvedParams = await params;
  const resolvedSearchParams = await searchParams;

  try {
    const user = await requireDbUser();

    // A direct URL is not a read grant: the shared task predicate decides.
    const task = await prisma.task.findFirst({
      where: await getTaskReadWhere(user, { id: resolvedParams.taskId }),
      include: taskDetailInclude,
    });

    if (!task || task.projectId !== resolvedParams.id) {
      notFound();
    }

    const projected = await toTaskDetailForReader(prisma, user, task);

    return (
      <TaskDetailPage
        projectId={resolvedParams.id}
        taskId={resolvedParams.taskId}
        task={projected}
        initialActorId={user.id}
        initialTab={resolvedSearchParams.tab}
        messageId={resolvedSearchParams.msg}
      />
    );
  } catch (error) {
    console.error("[task/page] Error:", error);
    notFound();
  }
}
