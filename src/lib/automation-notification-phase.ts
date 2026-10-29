/** Shared mutation phase policy. Conditions and notification recipients use the
 * authoritative pre-action Task snapshot inside each rule transaction.
 * Chaining none: generated events carry origin=automation and are ignored.
 * A per-rule/event receipt and stable per-action UUIDs deduplicate retries.
 */
import type { AutomationAction } from "./automation-actions";
import type { CreateNotificationParams } from "./notifications";

export const AUTOMATION_DEFERRED_MUTATION_ACTIONS = [] as const;
export const AUTOMATION_EXECUTION_POLICY = {
  phase: "shared_mutations",
  chaining: "none",
  retry: "caller_event",
  conditionSnapshot: "rule_transaction",
  deferredMutations: AUTOMATION_DEFERRED_MUTATION_ACTIONS,
} as const;

export interface AutomationNotificationTask {
  id: string;
  projectId: string;
  title: string;
  createdById: string | null;
  assignees: readonly { userId: string }[];
}

export class AutomationNotificationPlanError extends Error {
  readonly code = "RECIPIENT_UNAVAILABLE" as const;
  constructor() {
    super("RECIPIENT_UNAVAILABLE");
    this.name = "AutomationNotificationPlanError";
  }
}

export interface AutomationNotificationPlan {
  /** Recipients whose current access must be verified before any insert. */
  recipients: string[];
  notifications: CreateNotificationParams[];
}

/**
 * Pure planner for the closed notification catalog. It performs no I/O and
 * returns exactly the rows the rule transaction will persist.
 */
export function planAutomationNotifications(
  actions: readonly AutomationAction[],
  task: AutomationNotificationTask,
): AutomationNotificationPlan {
  const notifications: CreateNotificationParams[] = [];
  const recipients = new Set<string>();
  for (const action of actions) {
    if (action.type !== "notify_creator" && action.type !== "notify_assignees") continue;
    let userIds: string[];
    if (action.type === "notify_creator") {
      if (!task.createdById) throw new AutomationNotificationPlanError();
      userIds = [task.createdById];
    } else {
      userIds = [...new Set(task.assignees.map(assignee => assignee.userId))];
    }
    for (const userId of userIds) {
      recipients.add(userId);
      notifications.push({
        userId,
        type: "automation_rule",
        title: action.params.title || "Автоматическое уведомление",
        message: action.params.message || (action.type === "notify_creator"
          ? `Задача "${task.title}" обновлена`
          : `Задача "${task.title}" требует вашего внимания`),
        actionUrl: `/projects/${task.projectId}/board?task=${task.id}`,
        metadata: { taskId: task.id, projectId: task.projectId, ruleType: action.type },
      });
    }
  }
  return { recipients: [...recipients], notifications };
}
