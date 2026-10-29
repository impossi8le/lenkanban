import { z } from "zod";
import {
  decodeTaskRequestMarker,
  type TaskRequestMarker as BaseTaskRequestMarker,
  type TaskRequestState,
} from "./task-request-policy";

export type TaskRequestLifecycleMarker = BaseTaskRequestMarker & Readonly<{
  needsInfoSince: Date | null;
  pausedTotalMs: number;
}>;
type TaskRequestMarker = BaseTaskRequestMarker;

const pauseSchema = z.object({
  needsInfoSince: z.date().nullable().default(null),
  pausedTotalMs: z.number().int().min(0).max(2147483647).default(0),
}).strict();

/**
 * Closed lifecycle command vocabulary for marked requests. This module is the
 * single planner: HTTP validation, the command service and the DELETE helper
 * all use the same table. It never reads storage, permissions or logs.
 */
export const TASK_REQUEST_LIFECYCLE_ACTIONS = [
  "submit",
  "take",
  "take_over",
  "assign",
  "request_info",
  "answer_info",
  "complete",
  "close",
  "reopen",
  "cancel",
  "delete",
  "edit_description",
  "return_for_revision",
  "mark_invoice_ready",
  "approve",
] as const;
export type TaskRequestLifecycleAction =
  (typeof TASK_REQUEST_LIFECYCLE_ACTIONS)[number];

export const TASK_REQUEST_LIFECYCLE_DENIALS = [
  "INVALID_LIFECYCLE_ACTION",
  "NOT_A_REQUEST",
  "FORBIDDEN_ROLE",
  "INVALID_TRANSITION",
  "ASSIGNEE_REQUIRED",
  "REASON_REQUIRED",
  "RESPONSE_REQUIRED",
  "DESCRIPTION_REQUIRED",
] as const;
export type TaskRequestLifecycleDenial =
  (typeof TASK_REQUEST_LIFECYCLE_DENIALS)[number];

const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const identifierSchema = z.string().regex(identifier);
const maxReasonLength = 2000;
const maxDescriptionLength = 50_000;

export function isTaskRequestIdentifier(value: unknown): value is string {
  return typeof value === "string" && identifier.test(value);
}

const responseSchema = z
  .object({
    commentId: identifierSchema.optional(),
    attachmentId: identifierSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.commentId !== undefined || value.attachmentId !== undefined,
    "A comment or attachment is required",
  );

const payloadKeys = ["assigneeId", "reason", "response", "description", "invoiceUrl"] as const;

/** Strict command body. Cross-board fields (projectId/columnId) are unknown. */
export const taskRequestLifecycleCommandSchema = z
  .object({
    operationId: z.string().uuid(),
    expectedVersion: z.number().int().min(0).max(2147483647),
    action: z.enum(TASK_REQUEST_LIFECYCLE_ACTIONS),
    assigneeId: identifierSchema.optional(),
    invoiceUrl: z.string().trim().min(1).max(512).regex(/^\/api\/tasks\/[A-Za-z0-9_-]+\/files\/[A-Za-z0-9_-]+$/).optional(),
    reason: z.string().trim().min(1).max(maxReasonLength).optional(),
    response: responseSchema.optional(),
    description: z
      .string()
      .trim()
      .max(maxDescriptionLength)
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const allowed: readonly (typeof payloadKeys)[number][] =
      value.action === "mark_invoice_ready" ? ["invoiceUrl"] : value.action === "assign"
        ? ["assigneeId"]
        : value.action === "answer_info"
          ? ["response"]
          : value.action === "reopen" || value.action === "request_info" || value.action === "return_for_revision"
            ? ["reason"]
            : value.action === "edit_description"
              ? ["description"]
              : [];
    for (const key of payloadKeys) {
      if (!allowed.includes(key) && value[key] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `Field is not allowed for ${value.action}`,
        });
      }
    }
    if(value.action==="mark_invoice_ready"&&value.invoiceUrl===undefined)ctx.addIssue({code:"custom",path:["invoiceUrl"],message:"A published invoice file is required"});
    if (value.action === "assign" && value.assigneeId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["assigneeId"],
        message: "An assignee is required",
      });
    }
    if (value.action === "answer_info" && value.response === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["response"],
        message: "A response is required",
      });
    }
    if ((value.action === "reopen" || value.action === "return_for_revision") && value.reason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "A reason is required",
      });
    }
    if (
      value.action === "edit_description" &&
      value.description === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["description"],
        message: "A description is required",
      });
    }
  });

export type TaskRequestLifecycleCommand = z.infer<
  typeof taskRequestLifecycleCommandSchema
>;

/**
 * Server-established facts for one actor; never taken from request payload.
 * `canParticipate` is the common project policy's read boundary
 * (`getProjectAccess().canRead`), not a legacy writer right. `canExecute` is
 * active responsible-group membership or scoped department leadership.
 */
export interface TaskRequestActorFacts {
  readonly actorId: string;
  readonly isAuthor: boolean;
  readonly isExecutor: boolean;
  readonly isLeader: boolean;
  /** Fresh leader of this board's active responsible group; never department leadership. */
  readonly isResponsibleGroupLeader?: boolean;
  readonly canParticipate: boolean;
  readonly canExecute: boolean;
  readonly canReturnForRevision?: boolean;
  readonly canApprove?: boolean;
  readonly isBeznal?: boolean;
  readonly invoiceEligible?: boolean;
  readonly beznalPhase?: "WAITING" | "INVOICED" | null;
}

export interface TaskRequestTransitionRequest {
  readonly action: TaskRequestLifecycleAction;
  readonly assigneeId?: string;
  readonly invoiceUrl?: string;
  readonly reason?: string;
  readonly response?: {
    readonly commentId?: string;
    readonly attachmentId?: string;
  };
  readonly description?: string | null;
  readonly currentDescription?: string | null;
  readonly executorAvailable?: boolean;
}

export interface TaskRequestTransitionPlan {
  readonly allowed: true;
  readonly nextState: TaskRequestState;
  readonly nextExecutorId: string | null;
  readonly changed: boolean;
  readonly activityAction: string;
  readonly activity: {
    readonly oldValue: Record<string, unknown>;
    readonly newValue: Record<string, unknown>;
  };
}

export type TaskRequestTransitionDecision =
  | TaskRequestTransitionPlan
  | { readonly allowed: false; readonly code: TaskRequestLifecycleDenial };

function denied(code: TaskRequestLifecycleDenial): TaskRequestTransitionDecision {
  return { allowed: false, code };
}

function transition(
  marker: TaskRequestMarker,
  nextState: TaskRequestState,
  nextExecutorId: string | null,
  activityAction: string,
  extra: Record<string, unknown> = {},
): TaskRequestTransitionPlan {
  return {
    allowed: true,
    nextState,
    nextExecutorId,
    changed:
      marker.state !== nextState || marker.executorId !== nextExecutorId,
    activityAction,
    activity: {
      oldValue: { state: marker.state, executorId: marker.executorId },
      newValue: { state: nextState, executorId: nextExecutorId, ...extra },
    },
  };
}

function noChange(
  marker: TaskRequestMarker,
  activityAction: string,
): TaskRequestTransitionPlan {
  return transition(
    marker,
    marker.state,
    marker.executorId,
    activityAction,
  );
}

function nonEmpty(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function responseIdentifiers(
  response: TaskRequestTransitionRequest["response"],
): { commentId?: string; attachmentId?: string } | null {
  if (!response || typeof response !== "object") return null;
  const commentId = nonEmpty(response.commentId);
  const attachmentId = nonEmpty(response.attachmentId);
  if (commentId === null && attachmentId === null) return null;
  return {
    ...(commentId === null ? {} : { commentId }),
    ...(attachmentId === null ? {} : { attachmentId }),
  };
}

/**
 * Pure transition table for the agreed request lifecycle. Roles are already
 * resolved by the caller after fresh authorization. Repeating an already
 * applied command is a no-op (no Activity/effect), never a second transition.
 */
export function planTaskRequestTransition(
  marker: TaskRequestMarker,
  actor: TaskRequestActorFacts,
  request: TaskRequestTransitionRequest,
): TaskRequestTransitionDecision {
  if (marker.authorId !== actor.actorId && actor.isAuthor) return denied("FORBIDDEN_ROLE");
  if (marker.executorId !== actor.actorId && actor.isExecutor) return denied("FORBIDDEN_ROLE");
  if (!actor.canParticipate) return denied("FORBIDDEN_ROLE");

  if(actor.isBeznal&&(["complete","close","reopen"].includes(request.action)||["cancel","delete"].includes(request.action)&&!actor.isAuthor))return denied("FORBIDDEN_ROLE");
  switch (request.action) {
    case "mark_invoice_ready": {
      if(!actor.isBeznal)return denied("INVALID_TRANSITION");
      if(!actor.isExecutor||!actor.canExecute)return denied("FORBIDDEN_ROLE");
      if(!["IN_PROGRESS","NEEDS_INFO"].includes(marker.state)||!actor.invoiceEligible)return denied("INVALID_TRANSITION");
      if(actor.beznalPhase==="INVOICED")return noChange(marker,"request_invoice_marked_ready");
      return {...transition(marker,marker.state,marker.executorId,"request_invoice_marked_ready",{beznalPhase:"INVOICED"}),changed:true};
    }
    case "approve": {
      if(!actor.isBeznal)return denied("INVALID_TRANSITION");
      if(!actor.isAuthor&&!actor.canApprove)return denied("FORBIDDEN_ROLE");
      if(actor.beznalPhase!=="INVOICED"||!["SUBMITTED","IN_PROGRESS","NEEDS_INFO"].includes(marker.state))return denied("INVALID_TRANSITION");
      return transition(marker,"CLOSED",marker.executorId,"request_approved");
    }
    case "return_for_revision": {
      if (!actor.isAuthor&&!actor.canReturnForRevision&&!actor.canApprove) return denied("FORBIDDEN_ROLE");
      const reason=nonEmpty(request.reason);
      if (!reason) return denied("REASON_REQUIRED");
      if (!["SUBMITTED","IN_PROGRESS","NEEDS_INFO","COMPLETED","CLOSED"].includes(marker.state) || !actor.beznalPhase) return denied("INVALID_TRANSITION");
      if (actor.beznalPhase==="WAITING"&&["SUBMITTED","IN_PROGRESS"].includes(marker.state)) return noChange(marker,"request_returned_for_revision");
      const plan=transition(marker,marker.executorId===null?"SUBMITTED":"IN_PROGRESS",marker.executorId,"request_returned_for_revision",{reason,beznalPhase:"WAITING"});
      return {...plan,changed:true};
    }
    case "submit":
      if (!actor.isAuthor) return denied("FORBIDDEN_ROLE");
      if (marker.state === "SUBMITTED") return noChange(marker, "request_submitted");
      if (marker.state !== "DRAFT") return denied("INVALID_TRANSITION");
      return transition(marker, "SUBMITTED", null, "request_submitted");

    case "take":
      if (!actor.canExecute) return denied("FORBIDDEN_ROLE");
      if (marker.state === "IN_PROGRESS" && marker.executorId === actor.actorId) {
        return noChange(marker, "request_taken");
      }
      if (marker.state !== "SUBMITTED") return denied("INVALID_TRANSITION");
      if (marker.executorId !== null) return denied("INVALID_TRANSITION");
      return transition(marker, "IN_PROGRESS", actor.actorId, "request_taken");

    case "take_over":
      if (!actor.canExecute) return denied("FORBIDDEN_ROLE");
      if ((marker.state !== "IN_PROGRESS" && marker.state !== "NEEDS_INFO") || marker.executorId === null) {
        return denied("INVALID_TRANSITION");
      }
      return transition(marker, marker.state, actor.actorId, "request_assigned", {
        assigneeId: actor.actorId,
        takenOver: true,
      });

    case "assign": {
      if (!actor.isLeader && !actor.isExecutor) return denied("FORBIDDEN_ROLE");
      if (!actor.canExecute) return denied("FORBIDDEN_ROLE");
      if (
        marker.state !== "SUBMITTED" &&
        marker.state !== "IN_PROGRESS" &&
        marker.state !== "NEEDS_INFO"
      ) {
        return denied("INVALID_TRANSITION");
      }
      const assigneeId = nonEmpty(request.assigneeId);
      if (assigneeId === null || !identifier.test(assigneeId)) {
        return denied("ASSIGNEE_REQUIRED");
      }
      return transition(marker, "IN_PROGRESS", assigneeId, "request_assigned", {
        assigneeId,
      });
    }

    case "request_info": {
      if (!actor.canExecute) return denied("FORBIDDEN_ROLE");
      const reason = nonEmpty(request.reason);
      if (marker.state === "NEEDS_INFO" && actor.isExecutor) {
        return noChange(marker, "request_info_requested");
      }
      if (!actor.isExecutor && !actor.isLeader) return denied("FORBIDDEN_ROLE");
      if (marker.state !== "IN_PROGRESS") return denied("INVALID_TRANSITION");
      if (marker.executorId === null) return denied("INVALID_TRANSITION");
      return transition(marker, "NEEDS_INFO", marker.executorId, "request_info_requested",
        reason === null ? {} : { reason });
    }

    case "answer_info": {
      if (!actor.isAuthor) return denied("FORBIDDEN_ROLE");
      const response = responseIdentifiers(request.response);
      if (response === null) return denied("RESPONSE_REQUIRED");
      if (marker.state === "IN_PROGRESS") {
        return noChange(marker, "request_info_answered");
      }
      if (marker.state !== "NEEDS_INFO") return denied("INVALID_TRANSITION");
      if (marker.executorId === null) return denied("INVALID_TRANSITION");
      return transition(marker, "IN_PROGRESS", marker.executorId, "request_info_answered", {
        response,
      });
    }

    case "complete":
      if (!actor.canExecute) return denied("FORBIDDEN_ROLE");
      if (marker.state === "COMPLETED" && actor.isExecutor) {
        return noChange(marker, "request_completed");
      }
      if (!actor.isExecutor) return denied("FORBIDDEN_ROLE");
      if (marker.state !== "IN_PROGRESS") return denied("INVALID_TRANSITION");
      if (marker.executorId === null) return denied("INVALID_TRANSITION");
      return transition(marker, "COMPLETED", marker.executorId, "request_completed");

    case "close": {
      if (!(actor.isExecutor && actor.canExecute) && actor.isResponsibleGroupLeader !== true) {
        return denied("FORBIDDEN_ROLE");
      }
      if (marker.executorId === null) return denied("INVALID_TRANSITION");
      if (marker.state === "CLOSED") return noChange(marker, "request_closed");
      if (marker.state !== "COMPLETED") return denied("INVALID_TRANSITION");
      return transition(marker, "CLOSED", marker.executorId, "request_closed");
    }

    case "reopen": {
      if (!actor.isAuthor) return denied("FORBIDDEN_ROLE");
      if (marker.state !== "COMPLETED" && marker.state !== "CLOSED") return denied("INVALID_TRANSITION");
      const reason = nonEmpty(request.reason);
      if (reason === null) return denied("REASON_REQUIRED");
      const executorId =
        request.executorAvailable === true && marker.executorId !== null
          ? marker.executorId
          : null;
      return transition(
        marker,
        executorId === null ? "SUBMITTED" : "IN_PROGRESS",
        executorId,
        "request_reopened",
        { reason },
      );
    }

    case "cancel":
    case "delete": {
      const activityAction =
        request.action === "cancel" ? "request_cancelled" : "request_deleted";
      if (marker.state === "CANCELLED") return noChange(marker, activityAction);
      if (marker.state === "DRAFT" || marker.state === "SUBMITTED") {
        if (!actor.isAuthor) return denied("FORBIDDEN_ROLE");
        return transition(marker, "CANCELLED", null, activityAction);
      }
      if (marker.state === "IN_PROGRESS" || marker.state === "NEEDS_INFO") {
        if (!actor.isExecutor && !actor.isLeader) return denied("FORBIDDEN_ROLE");
        if (!actor.canExecute) return denied("FORBIDDEN_ROLE");
        return transition(
          marker,
          "CANCELLED",
          marker.executorId,
          activityAction,
        );
      }
      return denied("INVALID_TRANSITION");
    }

    case "edit_description": {
      if (request.description === undefined) return denied("DESCRIPTION_REQUIRED");
      if (marker.state === "DRAFT") {
        if (!actor.isAuthor) return denied("FORBIDDEN_ROLE");
      } else if (
        marker.state === "SUBMITTED" ||
        marker.state === "IN_PROGRESS" ||
        marker.state === "NEEDS_INFO"
      ) {
        if (!actor.isAuthor && !actor.isExecutor) return denied("FORBIDDEN_ROLE");
      } else {
        return denied("INVALID_TRANSITION");
      }
      const nextDescription = request.description;
      const changed = (request.currentDescription ?? null) !== nextDescription;
      return {
        allowed: true,
        nextState: marker.state,
        nextExecutorId: marker.executorId,
        changed,
        activityAction: "description_changed",
        activity: {
          oldValue: { description: request.currentDescription ?? null },
          newValue: { description: nextDescription },
        },
      };
    }

    default:
      return denied("INVALID_LIFECYCLE_ACTION");
  }
}

export const TASK_REQUEST_CONTENT_KINDS = ["comment", "attachment"] as const;
export type TaskRequestContentKind =
  (typeof TASK_REQUEST_CONTENT_KINDS)[number];

export type TaskRequestContentDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: TaskRequestLifecycleDenial };

export interface TaskRequestContentActorFacts {
  readonly actorId: string;
  readonly isAuthor: boolean;
  readonly isExecutor: boolean;
  readonly isWatcher: boolean;
  /** Participation resolved by the common project reader, including observers. */
  readonly isReader?: boolean;
  /** Active responsible group of the board, resolved by the caller. */
  readonly isGroupMember: boolean;
  readonly isLeader: boolean;
}

/**
 * Pure rule for the writers that add a comment or a file to a marked request.
 * They are discussion writers, never lifecycle writers: no state changes, no
 * clarification is cleared, and a cancelled request takes no new content.
 * A draft stays the author's private area; after submission the request's
 * participants and the board's responsible group share ordinary discussion.
 */
export function planTaskRequestContentMutation(
  marker: TaskRequestMarker,
  actor: TaskRequestContentActorFacts,
  kind: TaskRequestContentKind,
): TaskRequestContentDecision {
  if (!TASK_REQUEST_CONTENT_KINDS.includes(kind)) {
    return denied("INVALID_LIFECYCLE_ACTION");
  }
  if (marker.state === "CANCELLED") return denied("INVALID_TRANSITION");
  if (marker.state === "DRAFT") {
    return actor.isAuthor ? { allowed: true } : denied("FORBIDDEN_ROLE");
  }
  if (
    actor.isAuthor ||
    actor.isExecutor ||
    actor.isWatcher ||
    actor.isReader ||
    actor.isGroupMember ||
    actor.isLeader
  ) {
    return { allowed: true };
  }
  return denied("FORBIDDEN_ROLE");
}

/**
 * Closed projection used by the command service and the DELETE helper.
 * A malformed stored marker is never treated as a legacy task.
 */
export function decodeStoredTaskRequest(
  value: unknown,
  expectedTaskId: string,
): { readonly valid: true; readonly marker: TaskRequestLifecycleMarker | null } | { readonly valid: false } {
  try {
    if (value === null) return { valid: true, marker: null };
    if (typeof value !== "object" || Array.isArray(value)) return { valid: false };
    const base: Record<string, unknown> = {};
    const pause: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return { valid: false };
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return { valid: false };
      const target = key === "needsInfoSince" || key === "pausedTotalMs" ? pause : base;
      Object.defineProperty(target, key, { value: descriptor.value, enumerable: true });
    }
    const decoded = decodeTaskRequestMarker(base, expectedTaskId);
    const timers = pauseSchema.safeParse(pause);
    if (!decoded.valid || decoded.marker === null || !timers.success) return { valid: false };
    if (decoded.marker.state !== "NEEDS_INFO" && timers.data.needsInfoSince !== null) return { valid: false };
    return { valid: true, marker: { ...decoded.marker, ...timers.data } };
  } catch {
    return { valid: false };
  }
}
