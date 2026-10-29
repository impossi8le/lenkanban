/** Actor-specific safe metadata only; no task/comment/file contents. */
export type TaskChangeSummary = {
  latestVisibleChange: { kind: string; at: string; label: string } | null;
  snapshotToken: string;
  unseen: boolean;
  notificationCount?: number;
};
export type TaskChangesResponse = { actorId: string; byTask: Record<string, TaskChangeSummary> };

/** Public canonical work events only. Messages/files require actor-aware provenance. */
export const TASK_VISIBLE_WORK_ACTIONS = ["request_approved","request_invoice_marked_ready","request_submitted","request_taken","request_assigned","request_info_requested","request_info_answered","request_completed","request_closed","request_reopened","request_cancelled","request_returned_for_revision","description_changed","title_changed","priority_changed","deadline_set","deadline_changed","deadline_removed","status_changed"] as const;
