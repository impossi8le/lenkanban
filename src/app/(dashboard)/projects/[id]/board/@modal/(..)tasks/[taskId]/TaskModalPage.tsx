"use client";

import { useRouter } from "next/navigation";
import { TaskCommandPanel } from "@/components/task/TaskCommandPanel";
import type { TaskType } from "@/components/kanban/Card";

type Props = { projectId: string; taskId: string; task: TaskType; initialActorId?: string; initialTab?: string; messageId?: string };
export function TaskModalPage({ projectId, taskId, task, initialActorId }: Props) {
  const router = useRouter();
  return <TaskCommandPanel projectId={projectId} taskId={taskId} task={task} initialActorId={initialActorId} onClose={() => router.back()} />;
}
