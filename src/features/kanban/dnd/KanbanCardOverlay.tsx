"use client";

import {
  KanbanCardView,
  type TaskType,
} from "@/components/kanban/Card";

export interface KanbanCardOverlayProps {
  task: TaskType;
}

export function KanbanCardOverlay({
  task,
}: KanbanCardOverlayProps): React.ReactElement {
  return <KanbanCardView task={task} animatePresence={false} />;
}
