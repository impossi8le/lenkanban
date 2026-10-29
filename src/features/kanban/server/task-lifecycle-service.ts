import { isBeznalProject } from "@/lib/request-presentation";
import { persistTaskContentNotifications } from "@/app/api/tasks/[id]/messages/discussion-notifications";
import { deliverNotifications } from "@/lib/notifications";
import { loadRoleGrants, hasRolePermission } from "@/lib/role-grants";
import { canExecuteRequest, getProjectRequestStaffWhere } from "@/lib/project-request-execution-policy";
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { logActivityWithClient } from "@/lib/activity-logger";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { recordRequestQueueArrival, readRequestQueueRecipientIds } from "@/lib/request-queue-unseen";
import { emitRequestQueueInvalidation } from "@/socket/request-queue-events";
import { getProjectAccess, getTaskReadWhere } from "@/lib/project-access";
import { canReadTaskAudience, isTaskAudienceRecipient, readTaskAudience, type TaskAudience } from "@/lib/task-audience";
import { getProjectStatusPolicy } from "@/lib/project-status-policy";
import { ownTaskProjectIds } from "@/lib/access-policy";
import { notifyTaskRequestQueueEntered } from "@/lib/notification-triggers";
import type { TaskRequestState } from "@/lib/task-request-policy";
import { lockLifecyclePlacement, prepareLifecyclePlacement } from "./task-request-placement";
import { LifecycleColumnConfigurationError } from "@/lib/task-request-columns";
import {
  attachmentBelongsToTask,
  parseAttachmentFileUrl,
  parseStoredAttachments,
  publicTaskAttachmentDTOs,
  effectiveBeznalPhase,
  filterTaskAttachmentsForReader,
} from "@/lib/attachments/task-port";
import {
  decodeStoredTaskRequest,
  planTaskRequestContentMutation,
  planTaskRequestTransition,
  taskRequestLifecycleCommandSchema,
  type TaskRequestActorFacts,
  type TaskRequestContentKind,
  type TaskRequestLifecycleAction,
  type TaskRequestLifecycleDenial,
  type TaskRequestLifecycleMarker as TaskRequestMarker,
} from "@/lib/task-request-marker-lifecycle";

/**
 * One lifecycle command service for marked requests. It reuses the existing
 * Project → Column → Task → actor → project-access order and the existing
 * Activity/receipt tables; it does not introduce a second mutation engine.
 */
export type TaskLifecycleErrorCode =
  | TaskRequestLifecycleDenial
  | "INVALID_COMMAND"
  | "INVALID_REQUEST_MARKER"
  | "IDENTITY_CHANGED"
  | "STALE_TASK_VERSION"
  | "VERSION_EXHAUSTED"
  | "OPERATION_ID_REUSED"
  | "INVALID_RECEIPT"
  | "ASSIGNEE_NOT_ELIGIBLE"
  | "LIFECYCLE_COLUMNS_REQUIRED"
  | "INVALID_LIFECYCLE_COLUMNS";

export class TaskLifecycleError extends Error {
  constructor(readonly code: TaskLifecycleErrorCode) {
    super(code);
    this.name = "TaskLifecycleError";
  }
}

export interface TaskLifecycleCommandInput {
  actorId: string;
  taskId: string;
  operationId: string;
  expectedVersion: number;
  action: TaskRequestLifecycleAction;
  assigneeId?: string;
  invoiceUrl?: string;
  reason?: string;
  response?: { commentId?: string; attachmentId?: string };
  description?: string | null;
}

export interface TaskLifecycleAck {
  taskId: string;
  projectId: string;
  version: number;
  state: TaskRequestState;
  executorId: string | null;
  changed: boolean;
  replayed: boolean;
}

export interface TaskLifecycleEffects {
  reasonMessageId?: string;
  action: TaskRequestLifecycleAction;
  previousState: TaskRequestState;
  previousExecutorId: string | null;
  state: TaskRequestState;
  executorId: string | null;
}

export interface TaskLifecycleResult {
  ack: TaskLifecycleAck;
  effects: TaskLifecycleEffects | null;
}

export interface TaskLifecyclePermissions {
  isAuthor: boolean;
  isExecutor: boolean;
  isLeader: boolean;
  isGroupMember: boolean;
  canParticipate: boolean;
  canExecute: boolean;
  /** Whether this actor may pick another executor. */
  canAssign: boolean;
  isResponsibleGroupLeader?: boolean;
  canClose?: boolean;
  canReturnForRevision?: boolean;
  canApprove?: boolean;
  canMarkInvoiceReady?: boolean;
  /** Supported scalar transport capabilities, separate from task visibility. */
  canEditFields: boolean;
  canEditDescription: boolean;
  canSetDeadline: boolean;
  canUseLegacyAssignees: boolean;
}

export interface TaskLifecycleCandidate {
  id: string;
  name: string | null;
  email: string;
}

export interface TaskLifecycleAttachmentView {
  id: string;
  name: string;
  size: number;
  mime: string;
}

/** Server projection for the lifecycle controls; the server still re-checks every command. */
export interface TaskLifecycleSnapshot {
  workflowKind?: "beznal" | "default";
  beznalPhase?: "WAITING" | "INVOICED" | null;
  invoiceFiles?: {url:string;name:string}[];
  isPersonal?: boolean;
  taskId: string;
  projectId: string;
  version: number;
  marked: boolean;
  deleted: boolean;
  state: TaskRequestState | null;
  authorId: string | null;
  executorId: string | null;
  executorName: string | null;
  permissions: TaskLifecyclePermissions;
  assignees: TaskLifecycleCandidate[] | null;
  attachments: TaskLifecycleAttachmentView[];
}

const maxVersion = 2147483647;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const markerSelection = {
  taskId: true,
  contractVersion: true,
  state: true,
  authorId: true,
  executorId: true,
  needsInfoSince: true,
  pausedTotalMs: true,
} as const;

interface NormalizedCommand {
  actorId: string;
  taskId: string;
  operationId: string;
  expectedVersion: number;
  action: TaskRequestLifecycleAction;
  assigneeId?: string;
  invoiceUrl?: string;
  reason?: string;
  response?: { commentId?: string; attachmentId?: string };
  description?: string | null;
  requestHash: string;
}

function normalize(raw: TaskLifecycleCommandInput): NormalizedCommand {
  try {
    if (
      typeof raw.actorId !== "string" ||
      typeof raw.taskId !== "string" ||
      !idPattern.test(raw.actorId) ||
      !idPattern.test(raw.taskId)
    ) {
      throw new Error("invalid identity");
    }
    const parsed = taskRequestLifecycleCommandSchema.parse({
      operationId: raw.operationId,
      expectedVersion: raw.expectedVersion,
      action: raw.action,
      ...(raw.assigneeId === undefined ? {} : { assigneeId: raw.assigneeId }),
      ...(raw.invoiceUrl === undefined ? {} : { invoiceUrl: raw.invoiceUrl }),
      ...(raw.reason === undefined ? {} : { reason: raw.reason }),
      ...(raw.response === undefined ? {} : { response: raw.response }),
      ...(raw.description === undefined ? {} : { description: raw.description }),
    });
    const payload: Record<string, unknown> = {};
    if (parsed.assigneeId !== undefined) payload.assigneeId = parsed.assigneeId;
    if (parsed.invoiceUrl !== undefined) payload.invoiceUrl = parsed.invoiceUrl;
    if (parsed.reason !== undefined) payload.reason = parsed.reason;
    if (parsed.response !== undefined) {
      payload.response = {
        ...(parsed.response.commentId === undefined
          ? {}
          : { commentId: parsed.response.commentId }),
        ...(parsed.response.attachmentId === undefined
          ? {}
          : { attachmentId: parsed.response.attachmentId }),
      };
    }
    if (parsed.description !== undefined) payload.description = parsed.description;
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify([
          "request.lifecycle.v1",
          raw.taskId,
          parsed.action,
          payload,
          parsed.expectedVersion,
        ]),
      )
      .digest("hex");
    return {
      actorId: raw.actorId,
      taskId: raw.taskId,
      operationId: parsed.operationId.toLowerCase(),
      expectedVersion: parsed.expectedVersion,
      action: parsed.action,
      ...(parsed.assigneeId === undefined ? {} : { assigneeId: parsed.assigneeId }),
      ...(parsed.invoiceUrl === undefined ? {} : { invoiceUrl: parsed.invoiceUrl }),
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
      ...(parsed.response === undefined ? {} : { response: parsed.response }),
      ...(parsed.description === undefined
        ? {}
        : { description: parsed.description }),
      requestHash,
    };
  } catch {
    throw new TaskLifecycleError("INVALID_COMMAND");
  }
}

interface LockedTask {
  id: string;
  projectId: string;
  columnId: string;
  version: number;
  description: string | null;
  createdById: string | null;
}

async function lockProject(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<void> {
  const projects = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE
  `;
  if (!Array.isArray(projects) || projects.length === 0) throw new NotFoundError();
}

async function lockTask(
  tx: Prisma.TransactionClient,
  taskId: string,
  expectedProjectId: string,
): Promise<LockedTask> {
  const tasks = await tx.$queryRaw<LockedTask[]>`
    SELECT "id", "projectId", "columnId", "version", "description", "createdById"
    FROM "Task" WHERE "id" = ${taskId} FOR UPDATE
  `;
  if (!Array.isArray(tasks) || tasks.length === 0) throw new NotFoundError();
  const task = tasks[0];
  if (!task || task.projectId !== expectedProjectId) {
    throw new TaskLifecycleError("IDENTITY_CHANGED");
  }
  return task;
}

async function readMarker(
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<TaskRequestMarker | null> {
  const locked = await tx.$queryRaw<{ taskId: string }[]>`
    SELECT "taskId" FROM "TaskRequest" WHERE "taskId" = ${taskId} FOR UPDATE
  `;
  if (!Array.isArray(locked)) throw new Error("Invalid locked request marker");
  const row = await tx.taskRequest.findUnique({
    where: { taskId },
    select: { ...markerSelection, deletedAt: true },
  });
  const { deletedAt, ...fields } = row ?? { deletedAt: null };
  if (deletedAt !== null) throw new NotFoundError();
  const decoded = decodeStoredTaskRequest(row === null ? null : fields, taskId);
  if (!decoded.valid) throw new TaskLifecycleError("INVALID_REQUEST_MARKER");
  return decoded.marker;
}

type ActorRow = { id: string; globalRole: "USER" | "ADMIN"; name: string | null; isBlocked: boolean; blockedAt: Date | null; primaryDepartmentId: string | null };

async function freshActor(
  tx: Prisma.TransactionClient,
  actorId: string,
): Promise<ActorRow> {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actorId} FOR SHARE`;
  const actor = await tx.user.findUnique({
    where: { id: actorId },
    select: { id: true, globalRole: true, name: true, isBlocked: true, blockedAt: true, primaryDepartmentId: true },
  });
  if (!actor || actor.isBlocked !== false || actor.blockedAt !== null) throw new NotFoundError();
  return actor;
}

interface FreshAccess {
  actor: ActorRow;
  audience: TaskAudience | null;
  /** Fresh common task read; never a legacy writer right. */
  canParticipate: boolean;
  /** Destination department staff; active group fallback only without Department. */
  canExecute: boolean;
  canManageMembers: boolean;
  /** Active responsible group of the board is the request-execution role. */
  isGroupMember: boolean;
  isResponsibleGroupLeader: boolean;
  canReturnForRevision: boolean;
  canApprove: boolean;
}

/** Project is already locked. Match the rows changed by archive/leader UPDATE
 * and membership DELETE; never acquire topology mutex after Project. Facts
 * derive only from locked rows, including a missing membership (no grant). */
async function lockResponsibleGroupFacts(tx: Prisma.TransactionClient, projectId: string, actorId: string): Promise<{ isGroupMember: boolean; isResponsibleGroupLeader: boolean }> {
  const project = await tx.project.findUnique({ where: { id: projectId }, select: { responsibleGroupId: true } });
  if (!project?.responsibleGroupId) return { isGroupMember: false, isResponsibleGroupLeader: false };
  const [group] = await tx.$queryRaw<{ id: string; archivedAt: Date | null; leaderId: string | null }[]>`SELECT "id", "archivedAt", "leaderId" FROM "ResponsibleGroup" WHERE "id" = ${project.responsibleGroupId} FOR SHARE`;
  if (!group) return { isGroupMember: false, isResponsibleGroupLeader: false };
  const members = await tx.$queryRaw<{ userId: string }[]>`SELECT "userId" FROM "ResponsibleGroupMember" WHERE "groupId" = ${group.id} AND "userId" = ${actorId} FOR SHARE`;
  const isGroupMember = group.archivedAt === null && members.some(row => row.userId === actorId);
  return { isGroupMember, isResponsibleGroupLeader: isGroupMember && group.leaderId === actorId };
}

/** Caller already holds the exact Project and Task locks. */
async function freshAccess(
  tx: Prisma.TransactionClient,
  actorId: string,
  taskId: string,
  projectId: string,
): Promise<FreshAccess> {
  const groupFacts = await lockResponsibleGroupFacts(tx, projectId, actorId);
  const watchers = await tx.$queryRaw<{ userId: string }[]>`SELECT "userId" FROM "TaskWatcher" WHERE "taskId" = ${taskId} AND "userId" = ${actorId} FOR SHARE`;
  const department = await lockDepartmentFacts(tx, projectId);
  const actor = await freshActor(tx, actorId);
  const grants = await loadRoleGrants(tx, [actorId], { lock: true });
  const reader = await tx.task.findFirst({
    where: await getTaskReadWhere(actor, { id: taskId, projectId }, tx, { projectId, roleGrants: grants }),
    select: { id: true },
  });
  const isGroupMember = groupFacts.isGroupMember;
  const roleScope = { projectId, activeDepartmentId: department?.archivedAt === null ? department.id : null };
  const isLeader = (department?.archivedAt === null && department.leaderId === actorId)
    || hasRolePermission(grants, actorId, "request.manage", roleScope);
  // Task read is mandatory, never replaced by board discovery or execution
  // roles. The pure planner still decides each mutation from separate facts.
  if (!reader) throw new NotFoundError();
  const audience = await readTaskAudience(tx, taskId);
  const isWatcher = Array.isArray(watchers) && watchers.some(row => row.userId === actorId);
  if (!canReadTaskAudience(actor, audience, groupFacts.isResponsibleGroupLeader || isLeader, isWatcher)) throw new NotFoundError();
  const executionAudience = isTaskAudienceRecipient(audience, actorId);
  return {
    actor,
    audience,
    canParticipate: true,
    canApprove: hasRolePermission(grants, actorId, "request.approve", roleScope),
    canReturnForRevision: hasRolePermission(grants, actorId, "request.return_for_revision", roleScope),
    canExecute: executionAudience && canExecuteRequest({ hasDepartment: department !== null, isDepartmentStaff: department?.archivedAt === null && actor.primaryDepartmentId === department.id, isGroupMember, hasExecutionPermission: hasRolePermission(grants, actorId, "request.execute", roleScope) }),
    canManageMembers: executionAudience && isLeader,
    isGroupMember,
    isResponsibleGroupLeader: executionAudience && groupFacts.isResponsibleGroupLeader,
  };
}

function factsFrom(
  actorId: string,
  access: FreshAccess,
  authorId: string,
  executorId: string | null,
): TaskRequestActorFacts {
  return {
    actorId,
    isAuthor: authorId === actorId,
    isExecutor: executorId === actorId,
    isLeader: access.canManageMembers,
    isResponsibleGroupLeader: access.isResponsibleGroupLeader,
    canParticipate: access.canParticipate,
    canExecute: access.canExecute,
    canReturnForRevision: access.canReturnForRevision,
    canApprove: access.canApprove,
  };
}

async function canExecute(
  tx: Prisma.TransactionClient,
  userId: string,
  projectId: string,
  audience: TaskAudience | null,
  taskId: string,
): Promise<boolean> {
  if (!isTaskAudienceRecipient(audience, userId)) return false;
  const groupFacts = await lockResponsibleGroupFacts(tx, projectId, userId);
  const department = await lockDepartmentFacts(tx, projectId);
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR SHARE`;
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, globalRole: true, isBlocked: true, blockedAt: true, primaryDepartmentId: true },
  });
  if (!user || user.isBlocked !== false || user.blockedAt !== null) return false;
  const grants = await loadRoleGrants(tx, [userId], { lock: true });
  const readable = await tx.task.findFirst({ where: await getTaskReadWhere(user, { id: taskId, projectId }, tx, { projectId, roleGrants: grants }), select: { id: true } });
  if (!readable) return false;
  return canExecuteRequest({ hasDepartment: department !== null, isDepartmentStaff: department?.archivedAt === null && user.primaryDepartmentId === department.id, isGroupMember: groupFacts.isGroupMember,
    hasExecutionPermission: hasRolePermission(grants, userId, "request.execute", { projectId, activeDepartmentId: department?.archivedAt === null ? department.id : null }) });
}

export interface DeleteTaskLifecycleResult {
  logical: boolean;
  changed: boolean;
  state: TaskRequestState | null;
  /** The caller emits only after its outer transaction commits. No task data. */
  previousQueueRecipientIds?: string[];
}

/**
 * Shared DELETE boundary: marked requests are logically cancelled with audit,
 * legacy tasks keep physical deletion. The caller owns the transaction and
 * deletes the legacy row after this helper returns logical=false.
 */
export async function deleteTaskLifecycleAware(input: {
  tx: Prisma.TransactionClient;
  actorId: string;
  taskId: string;
  expectedProjectId: string;
}): Promise<DeleteTaskLifecycleResult> {
  const { tx, actorId, taskId, expectedProjectId } = input;
  await lockProject(tx, expectedProjectId);
  const task = await lockTask(tx, taskId, expectedProjectId);
  const access = await freshAccess(tx, actorId, task.id, task.projectId);
  const locked = await tx.$queryRaw<{ taskId: string }[]>`
    SELECT "taskId" FROM "TaskRequest" WHERE "taskId" = ${taskId} FOR UPDATE
  `;
  if (!Array.isArray(locked)) throw new Error("Invalid locked request marker");
  const row = await tx.taskRequest.findUnique({
    where: { taskId },
    select: markerSelection,
  });
  const decoded = decodeStoredTaskRequest(row, taskId);
  if (!decoded.valid) throw new TaskLifecycleError("INVALID_REQUEST_MARKER");
  if (decoded.marker === null) {
    return { logical: false, changed: false, state: null };
  }
  const marker = decoded.marker;
  const facts = factsFrom(
    actorId,
    access,
    marker.authorId,
    marker.executorId,
  );
  const deletionBusiness=await readBeznalBusinessState(tx,taskId,task.projectId);
  const plan = planTaskRequestTransition(marker, {...facts,isBeznal:deletionBusiness.enabled}, { action: "delete" });
  if (!plan.allowed) throw new TaskLifecycleError(plan.code);
  let previousQueueRecipientIds: string[] | undefined;
  if (plan.changed) {
    if (task.version === maxVersion) {
      throw new TaskLifecycleError("VERSION_EXHAUSTED");
    }
    if (marker.state === "SUBMITTED" && marker.executorId === null) {
      previousQueueRecipientIds = await readRequestQueueRecipientIds(tx, task.id, task.projectId);
    }
    const markerUpdate = await tx.taskRequest.updateMany({
      where: {
        taskId,
        state: marker.state,
        executorId: marker.executorId,
      },
      data: {
        state: plan.nextState,
        executorId: plan.nextExecutorId,
        ...pauseUpdate(marker, plan.nextState),
        // Logical deletion is distinct from cancellation: the row stays for
        // audit and the read predicate can exclude it from working queues.
        deletedAt: new Date(),
        deletedById: actorId,
      },
    });
    if (markerUpdate.count !== 1) {
      throw new TaskLifecycleError("STALE_TASK_VERSION");
    }
    const updated = await tx.task.updateMany({
      where: {
        id: task.id,
        projectId: task.projectId,
        columnId: task.columnId,
        version: task.version,
      },
      data: { version: { increment: 1 } },
    });
    if (updated.count !== 1) {
      throw new TaskLifecycleError("STALE_TASK_VERSION");
    }
    await logActivityWithClient(tx, {
      taskId,
      userId: actorId,
      action: plan.activityAction,
      oldValue: plan.activity.oldValue,
      newValue: plan.activity.newValue,
    });
  }
  return { logical: true, changed: plan.changed, state: plan.nextState,
    ...(previousQueueRecipientIds !== undefined ? { previousQueueRecipientIds } : {}) };
}

export type TaskRequestContentDecision =
  | { readonly allowed: true; readonly marked: false }
  | { readonly allowed: true; readonly marked: true; readonly state: TaskRequestState; readonly beznal?: boolean }
  | {
      readonly allowed: false;
      readonly code: TaskRequestLifecycleDenial | "INVALID_REQUEST_MARKER";
    };

/** Detaching original files uses the existing description authority, never
 * ordinary comment/upload participation. Caller owns the transaction. */
export async function authorizeTaskAttachmentDetach(input: {
  tx: Prisma.TransactionClient; actorId: string; taskId: string; expectedProjectId: string;
}) {
  const { tx, actorId, taskId, expectedProjectId } = input;
  await lockProject(tx, expectedProjectId);
  const task = await lockTask(tx, taskId, expectedProjectId);
  const access = await freshAccess(tx, actorId, taskId, expectedProjectId);
  const marker = await readMarker(tx, taskId);
  if (marker === null) {
    if (!(await getProjectAccess(access.actor, expectedProjectId, tx)).canWrite) throw new NotFoundError();
  } else {
    const decision = planTaskRequestTransition(marker, factsFrom(actorId, access, marker.authorId, marker.executorId), {
      action: "edit_description", description: task.description, currentDescription: task.description,
    });
    if (!decision.allowed) throw new TaskLifecycleError(decision.code);
  }
  return { actor: access.actor, version: task.version, projectId: task.projectId };
}

/**
 * Integration point for the discussion writers (comment, file). A task without
 * a marker stays on the caller's legacy path. A marked request is authorized by
 * the same common task read policy and the same pure content rule; the helper
 * never mutates the marker, so adding content cannot clear a clarification or
 * move a state. This helper locks and authorizes task reads for all content; callers retain
 * their legacy write guard when marked:false and pass the expected project.
 */
export async function authorizeTaskRequestContentWrite(input: {
  tx: Prisma.TransactionClient;
  actorId: string;
  taskId: string;
  expectedProjectId: string;
  kind: TaskRequestContentKind;
}): Promise<TaskRequestContentDecision> {
  const { tx, actorId, taskId, expectedProjectId, kind } = input;
  await lockProject(tx, expectedProjectId);
  const task = await lockTask(tx, taskId, expectedProjectId);
  const groupFacts = await lockResponsibleGroupFacts(tx, task.projectId, actorId);
  // This only stabilizes a possible read grant. A local row never overrides
  // getTaskReadWhere, and deletion waits until the caller's transaction commits.
  const watchers = await tx.$queryRaw<{ userId: string }[]>`
    SELECT "userId" FROM "TaskWatcher" WHERE "taskId" = ${taskId} AND "userId" = ${actorId} FOR SHARE
  `;
  const actor = await freshActor(tx, actorId);
  const audience = await readTaskAudience(tx, taskId);
  const isLeader = await isActiveDepartmentLeader(tx, task.projectId, actorId);
  const isWatcher = Array.isArray(watchers) && watchers.some(row => row.userId === actorId);
  if (!canReadTaskAudience(actor, audience, groupFacts.isResponsibleGroupLeader || isLeader, isWatcher)) throw new NotFoundError();
  const projectAccess = await getProjectAccess(actor, task.projectId, tx);
  const groupMember = groupFacts.isGroupMember;
  const locked = await tx.$queryRaw<{ taskId: string }[]>`
    SELECT "taskId" FROM "TaskRequest" WHERE "taskId" = ${taskId} FOR UPDATE
  `;
  if (!Array.isArray(locked)) throw new Error("Invalid locked request marker");
  const row = await tx.taskRequest.findUnique({
    where: { taskId },
    select: { ...markerSelection, deletedAt: true },
  });
  // Board discovery is never a content grant, including unmarked tasks. Recheck
  // the exact task inside the locked transaction after any outer route read.
  const reader = await tx.task.findFirst({
    where: await getTaskReadWhere(actor, { id: taskId, projectId: expectedProjectId }, tx, { projectId: expectedProjectId }),
    select: { id: true },
  });
  if (!reader) throw new NotFoundError();
  if (row === null) {
    if (!projectAccess.canRead) throw new NotFoundError();
    return { allowed: true, marked: false };
  }
  const { deletedAt, ...fields } = row;
  if (deletedAt !== null) throw new NotFoundError();
  const decoded = decodeStoredTaskRequest(fields, taskId);
  if (!decoded.valid || decoded.marker === null) {
    return { allowed: false, code: "INVALID_REQUEST_MARKER" };
  }
  const marker = decoded.marker;
  const decision = planTaskRequestContentMutation(
    marker,
    {
      actorId,
      isAuthor: marker.authorId === actorId,
      isExecutor: marker.executorId === actorId,
      isWatcher,
      isReader: true,
      isGroupMember: groupMember,
      isLeader,
    },
    kind,
  );
  if (!decision.allowed) return { allowed: false, code: decision.code };
  if(kind==="attachment"&&marker.authorId!==actorId && hasRolePermission(await loadRoleGrants(tx,[actorId],{lock:true}),actorId,"request.read.common",{projectId:task.projectId,activeDepartmentId:null}) && !(await canExecute(tx,actorId,task.projectId,audience,taskId)))return {allowed:false,code:"FORBIDDEN_ROLE"};
  const project=await tx.project.findUnique({where:{id:expectedProjectId},select:{name:true}});
  return { allowed: true, marked: true, state: marker.state, ...(isBeznalProject(project?.name??"")?{beznal:true}:{}) };
}

function pauseUpdate(marker: TaskRequestMarker, nextState: TaskRequestState): Prisma.TaskRequestUpdateManyMutationInput {
  if (marker.state === nextState) return {};
  const now = new Date();
  if (nextState === "NEEDS_INFO") return { needsInfoSince: now };
  if (marker.state !== "NEEDS_INFO") return {};
  return {
    needsInfoSince: null,
    pausedTotalMs: { increment: marker.needsInfoSince === null ? 0 : Math.max(0, now.getTime() - marker.needsInfoSince.getTime()) },
  };
}

/** Project binding is locked by caller; archive/leader facts stay fixed to commit. */
async function lockDepartmentFacts(tx: Prisma.TransactionClient, projectId: string) {
  const project = await tx.project.findUnique({ where: { id: projectId }, select: {
    department: { select: { id: true, leaderId: true, archivedAt: true } },
  } });
  if (!project?.department) return null;
  const departmentId = project.department.id;
  await tx.$queryRaw`SELECT "id" FROM "Department" WHERE "id" = ${departmentId} FOR SHARE`;
  const fresh = await tx.project.findUnique({ where: { id: projectId }, select: {
    department: { select: { id: true, leaderId: true, archivedAt: true } },
  } });
  if (!fresh?.department || fresh.department.id !== departmentId) throw new NotFoundError();
  return fresh.department;
}

async function isActiveDepartmentLeader(tx: Prisma.TransactionClient, projectId: string, userId: string): Promise<boolean> {
  const department = await lockDepartmentFacts(tx, projectId);
  return (department?.archivedAt === null && department.leaderId === userId)
    || hasRolePermission(await loadRoleGrants(tx, [userId], { lock: true }), userId, "request.manage", {
      projectId, activeDepartmentId: department?.archivedAt === null ? department.id : null,
    });
}

/** Destination department staff, or active group members only on unbound boards. */
async function eligibleAssignees(
  tx: Prisma.TransactionClient,
  projectId: string,
  audience: TaskAudience | null,
): Promise<TaskLifecycleCandidate[]> {
  const staff = await getProjectRequestStaffWhere(projectId, tx);
  const users = staff === null ? [] : await tx.user.findMany({
    where: staff, select: { id: true, name: true, email: true },
  });
  const project = await tx.project.findUnique({ where: { id: projectId }, select: { department: { select: { id: true, archivedAt: true } } } });
  const grants = await loadRoleGrants(tx, users.map(user => user.id));
  return users.filter(user => isTaskAudienceRecipient(audience, user.id) && hasRolePermission(grants, user.id, "request.execute", {
    projectId, activeDepartmentId: project?.department?.archivedAt === null ? project.department.id : null,
  })).sort((left, right) =>
    (left.name ?? left.email).localeCompare(right.name ?? right.email, "ru"),
  );
}

export async function readBeznalBusinessState(tx: Prisma.TransactionClient, taskId: string, projectId: string): Promise<{enabled:boolean;phase:"WAITING"|"INVOICED"|null}> {
  const project=await tx.project.findUnique({where:{id:projectId},select:{name:true}});
  if(!project||!isBeznalProject(project.name??""))return {enabled:false,phase:null};
  const row=await tx.taskRequest.findUnique({where:{taskId},select:{beznalPhase:true}});
  if(row?.beznalPhase==="WAITING"||row?.beznalPhase==="INVOICED")return {enabled:true,phase:row.beznalPhase};
  // Compatibility for reviewed legacy rows only. New writes persist their phase.
  const task=await tx.task.findUnique({where:{id:taskId},select:{attachments:true}});
  return {enabled:true,phase:effectiveBeznalPhase(row?.beznalPhase,task?.attachments)};
}

/** Caller persists NEW content first in this SAME transaction; never call on replay. */
export async function commitBeznalContentEffect(input:{tx:Prisma.TransactionClient;actorId:string;taskId:string;projectId:string;kind:"comment"|"invoice";public:boolean;invoiceUrl?:string;versionAlreadyIncremented?:boolean}):Promise<{claimed:boolean;phaseChanged:boolean;queueRecipientIds?:string[]}> {
  const {tx,actorId,taskId,projectId}=input;
  const none={claimed:false,phaseChanged:false};
  if(!input.public)return none;
  const business=await readBeznalBusinessState(tx,taskId,projectId);if(!business.enabled)return none;
  await lockProject(tx,projectId);const task=await lockTask(tx,taskId,projectId);
  const access=await freshAccess(tx,actorId,taskId,projectId),marker=await readMarker(tx,taskId);
  if(!marker||!access.canExecute||!["SUBMITTED","IN_PROGRESS","NEEDS_INFO"].includes(marker.state))return none;
  if(marker.executorId!==null&&marker.executorId!==actorId)return none;
  if(input.kind==="invoice"){
    const stored=await tx.task.findUnique({where:{id:taskId},select:{attachments:true}});
    if(!input.invoiceUrl||!parseAttachmentFileUrl(input.invoiceUrl,taskId)||!publicTaskAttachmentDTOs(stored?.attachments).some(file=>file.url===input.invoiceUrl))throw new TaskLifecycleError("INVALID_COMMAND");
  }
  const claimed=marker.state==="SUBMITTED"&&marker.executorId===null;
  if(marker.executorId===null&&!claimed)return none;
  const phase=input.kind==="invoice"?"INVOICED":"WAITING";
  const phaseChanged=input.kind==="invoice"&&business.phase!=="INVOICED";
  if(!claimed&&!phaseChanged&&input.kind!=="invoice")return none;
  const queueRecipientIds=claimed?await readRequestQueueRecipientIds(tx,taskId,projectId):undefined;
  let placementUpdate:Prisma.TaskUncheckedUpdateManyInput={};
  if(claimed){
    const plan=planTaskRequestTransition(marker,factsFrom(actorId,access,marker.authorId,marker.executorId),{action:"take"});
    if(!plan.allowed)throw new TaskLifecycleError(plan.code);
    const placement=await lockLifecyclePlacement(tx,projectId,task.columnId);
    if(placement.configurationError)throw new TaskLifecycleError(placement.configurationError);
    placementUpdate=await prepareLifecyclePlacement(tx,placement,task,plan.nextState);
  }
  const updated=await tx.taskRequest.updateMany({where:{taskId,state:marker.state,executorId:marker.executorId},data:{...(claimed?{state:"IN_PROGRESS",executorId:actorId}:{}),...(input.kind==="invoice"?{beznalPhase:"INVOICED",currentInvoiceUrl:input.invoiceUrl??null}:claimed?{beznalPhase:phase}:{} )}});
  if(updated.count!==1)throw new TaskLifecycleError("STALE_TASK_VERSION");
  // Attachment append/message CAS may already have incremented under this same
  // Task lock. Prisma empty updateMany reports zero without checking a row;
  // skip that no-op rather than reject a committed invoice-only phase change.
  const taskUpdate:Prisma.TaskUncheckedUpdateManyInput={...placementUpdate,...(!input.versionAlreadyIncremented?{version:{increment:1}}:{})};
  if(Object.keys(taskUpdate).length>0){
    const changed=await tx.task.updateMany({where:{id:taskId,projectId,columnId:task.columnId,version:task.version},data:taskUpdate});
    if(changed.count!==1)throw new TaskLifecycleError("STALE_TASK_VERSION");
  }
  if(claimed){await tx.taskAssignee.deleteMany({where:{taskId}});await tx.taskAssignee.create({data:{taskId,userId:actorId}});await logActivityWithClient(tx,{taskId,userId:actorId,action:"request_taken",oldValue:{state:marker.state,executorId:null},newValue:{state:"IN_PROGRESS",executorId:actorId,via:input.kind}});}
  if(placementUpdate.columnId!==undefined&&placementUpdate.columnId!==task.columnId)await tx.project.update({where:{id:projectId},data:{boardRevision:{increment:1}}});
  if(input.kind==="invoice")await logActivityWithClient(tx,{taskId,userId:actorId,action:"request_invoice_ready",newValue:{beznalPhase:"INVOICED"}});
  return {claimed,phaseChanged,...(queueRecipientIds?{queueRecipientIds}:{})};
}

export interface TaskLifecycleDependencies {
  invalidateQueue?: typeof emitRequestQueueInvalidation;
  /**
   * Post-commit queue notification, delivered once per committed submit.
   * A delivery failure cannot undo the committed ACK or repeat the transition.
   */
  notifyQueueEntered?: (input: {
    taskId: string;
    projectId: string;
    actorId: string;
    actorName: string;
  }) => Promise<unknown>;
}

/** Same task/authorization/Activity; this is not a second lifecycle engine. */
export function createTaskLifecycleService(
  database: Pick<PrismaClient, "$transaction">,
  dependencies: TaskLifecycleDependencies = {},
) {
  return {
    async transition(raw: TaskLifecycleCommandInput): Promise<TaskLifecycleResult> {
      const command = normalize(raw);
      const queue: { entry: { projectId: string; actorName: string } | null;
        invalidation: { taskId: string; projectId: string; previousRecipientIds: string[] } | null } = {
        entry: null,
        invalidation: null,
      };
      const contentNotifications: Awaited<ReturnType<typeof persistTaskContentNotifications>> = [];
      const result = await database.$transaction(
        async (tx) => {
          const operationKey = JSON.stringify([
            "task-request-lifecycle-v1",
            command.actorId,
            command.operationId,
          ]);
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${operationKey}, 0))::text AS locked`;
          const identity = await tx.task.findUnique({
            where: { id: command.taskId },
            select: { id: true, projectId: true, columnId: true },
          });
          if (!identity) throw new NotFoundError();
          await lockProject(tx, identity.projectId);
          const placement = await lockLifecyclePlacement(tx, identity.projectId, identity.columnId).catch(error => {
            if (error instanceof LifecycleColumnConfigurationError) throw new TaskLifecycleError(error.code);
            throw error;
          });
          const task = await lockTask(tx, command.taskId, identity.projectId);
          if (task.columnId !== identity.columnId) {
            throw new TaskLifecycleError("IDENTITY_CHANGED");
          }
          const access = await freshAccess(tx, command.actorId, task.id, task.projectId);
          if (placement.configurationError) throw new TaskLifecycleError(placement.configurationError);
          const storedMarker = await readMarker(tx, command.taskId);
          const earlyBusiness=await readBeznalBusinessState(tx,task.id,task.projectId);
          if(earlyBusiness.enabled&&(["complete","close","reopen"].includes(command.action)||["cancel","delete"].includes(command.action)&&storedMarker?.authorId!==command.actorId))throw new TaskLifecycleError("FORBIDDEN_ROLE");
          if(command.action==="approve"&&storedMarker?.authorId!==command.actorId&&!access.canApprove)throw new TaskLifecycleError("FORBIDDEN_ROLE");
          if(command.action==="mark_invoice_ready"&&!(storedMarker?.executorId===command.actorId&&access.canExecute))throw new TaskLifecycleError("FORBIDDEN_ROLE");
          // A historical close receipt is never a retained role grant. Check
          // current executor/group leadership before returning even its ACK.
          if (command.action === "close" && storedMarker !== null && !(
            (storedMarker.executorId === command.actorId && access.canExecute) || access.isResponsibleGroupLeader
          )) throw new TaskLifecycleError("FORBIDDEN_ROLE");
          if(command.action==="return_for_revision"&&!(storedMarker?.authorId===command.actorId||access.canReturnForRevision||access.canApprove))throw new TaskLifecycleError("FORBIDDEN_ROLE");
          const receipt = await tx.taskCommandOperation.findUnique({
            where: {
              actorId_operationId: {
                actorId: command.actorId,
                operationId: command.operationId,
              },
            },
          });
          if (receipt) {
            if (receipt.requestHash !== command.requestHash) {
              throw new TaskLifecycleError("OPERATION_ID_REUSED");
            }
            if (
              receipt.actorId !== command.actorId ||
              receipt.operationId !== command.operationId ||
              receipt.taskId !== task.id ||
              receipt.projectId !== task.projectId ||
              receipt.expectedVersion !== command.expectedVersion ||
              typeof receipt.changed !== "boolean" ||
              !Number.isInteger(receipt.committedVersion) ||
              receipt.committedVersion < 0 ||
              receipt.committedVersion > maxVersion ||
              receipt.committedVersion !==
                receipt.expectedVersion + (receipt.changed ? 1 : 0) ||
              storedMarker === null
            ) {
              throw new TaskLifecycleError("INVALID_RECEIPT");
            }
            return {
              ack: {
                taskId: task.id,
                projectId: task.projectId,
                version: receipt.committedVersion,
                state: storedMarker.state,
                executorId: storedMarker.executorId,
                changed: receipt.changed,
                replayed: true,
              },
              effects: null,
            };
          }
          let marker: TaskRequestMarker;
          if (storedMarker !== null) {
            marker = storedMarker;
          } else {
            // Boards outside LENKANBAN_OWN_TASK_PROJECT_IDS have no marker at
            // creation. The author activates the lifecycle by submitting the
            // legacy card; this creates the same canonical marker atomically
            // with the transition, so no second lifecycle engine appears.
            if (
              command.action !== "submit" ||
              task.createdById === null ||
              task.createdById !== command.actorId
            ) {
              throw new TaskLifecycleError("NOT_A_REQUEST");
            }
            const bootstrap: TaskRequestMarker = {
              taskId: task.id,
              contractVersion: 1,
              state: "DRAFT",
              authorId: command.actorId,
              executorId: null,
              needsInfoSince: null,
              pausedTotalMs: 0,
            };
            marker = bootstrap;
          }
          const business=earlyBusiness;
          const baseFacts = factsFrom(
            command.actorId,
            access,
            marker.authorId,
            marker.executorId,
          );
          let invoiceEligible=false;
          if(command.action==="mark_invoice_ready"){
            const stored=await tx.task.findUnique({where:{id:task.id},select:{attachments:true}});
            invoiceEligible=Boolean(command.invoiceUrl&&parseAttachmentFileUrl(command.invoiceUrl,task.id)&&publicTaskAttachmentDTOs(stored?.attachments).some(file=>file.url===command.invoiceUrl));
            if(!invoiceEligible)throw new TaskLifecycleError("INVALID_COMMAND");
          }
          const facts={...baseFacts,isBeznal:business.enabled,beznalPhase:business.phase,invoiceEligible};
          if(!business.enabled && ["return_for_revision","mark_invoice_ready","approve"].includes(command.action))throw new TaskLifecycleError("INVALID_TRANSITION");
          if (task.version !== command.expectedVersion) {
            throw new TaskLifecycleError("STALE_TASK_VERSION");
          }
          if ((command.action === "take" || command.action === "take_over") && !access.canExecute) {
            throw new TaskLifecycleError("FORBIDDEN_ROLE");
          }

          let executorAvailable = false;
          if (command.action === "reopen" && marker.executorId !== null) {
            executorAvailable = await canExecute(
              tx,
              marker.executorId,
              task.projectId,
              access.audience,
              task.id,
            );
          }
          const plan = planTaskRequestTransition(marker, facts, {
            action: command.action,
            ...(command.invoiceUrl===undefined?{}:{invoiceUrl:command.invoiceUrl}),
            ...(command.assigneeId === undefined
              ? {}
              : { assigneeId: command.assigneeId }),
            ...(command.reason === undefined ? {} : { reason: command.reason }),
            ...(command.response === undefined
              ? {}
              : { response: command.response }),
            ...(command.description === undefined
              ? {}
              : { description: command.description }),
            currentDescription: task.description,
            executorAvailable,
          });
          if (!plan.allowed) throw new TaskLifecycleError(plan.code);

          // An answer clears the pause only with content that already belongs
          // to this request and this author; a fabricated identifier is not a
          // response. Ordinary comments never call this transition.
          if (command.action === "answer_info") {
            const response = command.response;
            if (!response) throw new TaskLifecycleError("INVALID_COMMAND");
            if (response.commentId !== undefined) {
              const comment = await tx.chatMessage.findUnique({
                where: { id: response.commentId },
                select: { taskId: true, authorId: true, deletedAt: true },
              });
              if (
                !comment || comment.deletedAt != null ||
                comment.taskId !== task.id ||
                comment.authorId !== command.actorId
              ) {
                throw new TaskLifecycleError("INVALID_COMMAND");
              }
            }
            if (response.attachmentId !== undefined) {
              const current = await tx.task.findUnique({
                where: { id: task.id },
                select: { attachments: true },
              });
              const attachments = current
                ? parseStoredAttachments(current.attachments)
                : [];
              if (
                !attachmentBelongsToTask(
                  attachments,
                  task.id,
                  response.attachmentId,
                )
              ) {
                throw new TaskLifecycleError("INVALID_COMMAND");
              }
            }
          }

          if (command.action === "assign") {
            if (
              command.assigneeId === undefined ||
              !(await canExecute(tx, command.assigneeId, task.projectId, access.audience, task.id))
            ) {
              throw new TaskLifecycleError("ASSIGNEE_NOT_ELIGIBLE");
            }
          }

          let reasonMessageId:string|undefined;
          if (plan.changed) {
            if (task.version === maxVersion) {
              throw new TaskLifecycleError("VERSION_EXHAUSTED");
            }
            const wasQueued = marker.state === "SUBMITTED" && marker.executorId === null;
            const willQueue = plan.nextState === "SUBMITTED" && plan.nextExecutorId === null;
            if (wasQueued !== willQueue) {
              queue.invalidation = { taskId: task.id, projectId: task.projectId,
                previousRecipientIds: wasQueued ? await readRequestQueueRecipientIds(tx, task.id, task.projectId) : [] };
            }
            // Resolve/allocate before any marker write. All placement and rank
            // writes stay in this same transaction and rollback with its CAS.
            let placementUpdate: Prisma.TaskUncheckedUpdateManyInput = {};
            if (command.action !== "edit_description" && command.action !== "take_over" && command.action !== "mark_invoice_ready") {
              try { placementUpdate = await prepareLifecyclePlacement(tx, placement, task, plan.nextState); }
              catch (error) {
                if (error instanceof LifecycleColumnConfigurationError) throw new TaskLifecycleError(error.code);
                throw error;
              }
            }
            if (command.action !== "edit_description") {
              if (storedMarker === null) await tx.taskRequest.create({ data: marker });
              const markerUpdate = await tx.taskRequest.updateMany({
                where: {
                  taskId: task.id,
                  state: marker.state,
                  executorId: marker.executorId,
                },
                data: {
                  state: plan.nextState,
                  executorId: plan.nextExecutorId,
                  ...pauseUpdate(marker, plan.nextState),
                  ...(command.action==="mark_invoice_ready"?{beznalPhase:"INVOICED",currentInvoiceUrl:command.invoiceUrl}:command.action==="return_for_revision"?{beznalPhase:"WAITING",currentInvoiceUrl:null}:command.action==="submit"&&business.enabled?{beznalPhase:"WAITING"}:{}),
                },
              });
              if (markerUpdate.count !== 1) {
                throw new TaskLifecycleError("STALE_TASK_VERSION");
              }
            }
            const data: Prisma.TaskUncheckedUpdateManyInput = {
              ...placementUpdate,
              version: { increment: 1 },
            };
            if (command.action === "edit_description") {
              data.description = command.description ?? null;
            }
            const updated = await tx.task.updateMany({
              where: {
                id: task.id,
                projectId: task.projectId,
                columnId: task.columnId,
                version: command.expectedVersion,
              },
              data,
            });
            if (updated.count !== 1) {
              throw new TaskLifecycleError("STALE_TASK_VERSION");
            }
            if (marker.state !== "SUBMITTED" && plan.nextState === "SUBMITTED" && plan.nextExecutorId === null) {
              try { await recordRequestQueueArrival(tx, { taskId: task.id, actorId: command.actorId }); }
              catch (error) {
                if (error instanceof ConflictError) throw new TaskLifecycleError("VERSION_EXHAUSTED");
                throw error;
              }
            }
            if (placementUpdate.columnId !== undefined && placementUpdate.columnId !== task.columnId) {
              await tx.project.update({ where: { id: task.projectId }, data: { boardRevision: { increment: 1 } } });
            }
            // The marker is the single executor authority. Keep the legacy
            // assignee projection aligned so the card shows exactly one person
            // after take/assign/reopen; the legacy PUT is already closed for
            // marked requests by the shared guard.
            if (
              command.action === "take" ||
              command.action === "take_over" ||
              command.action === "assign" ||
              command.action === "reopen"
            ) {
              await tx.taskAssignee.deleteMany({ where: { taskId: task.id } });
              if (plan.nextExecutorId !== null) {
                await tx.taskAssignee.create({
                  data: { taskId: task.id, userId: plan.nextExecutorId },
                });
              }
            }
            if(command.action==="return_for_revision"){
              const message=await tx.chatMessage.create({data:{taskId:task.id,authorId:command.actorId,clientId:command.operationId,contentText:command.reason!,attachments:[],mentions:[],reactions:{},readBy:{[command.actorId]:new Date().toISOString()}}});
              reasonMessageId=message.id;
              contentNotifications.push(...await persistTaskContentNotifications({db:tx,taskId:task.id,actorId:command.actorId,actorName:access.actor.name?.trim()||"Участник",visibility:"PUBLIC",event:"return_for_revision",eventId:message.id}));
            }
            await logActivityWithClient(tx, {
              taskId: task.id,
              userId: command.actorId,
              action: plan.activityAction,
              oldValue: { ...plan.activity.oldValue, ...(placementUpdate.columnId !== undefined ? { columnId: task.columnId } : {}) },
              newValue: { ...plan.activity.newValue,
                ...(command.action === "edit_description" ? { afterSubmission: marker.state !== "DRAFT" } : {}),
                ...(placementUpdate.columnId !== undefined ? { columnId: placementUpdate.columnId, status: placementUpdate.status } : {}) },
            });
            if(command.action==="approve"||command.action==="mark_invoice_ready")contentNotifications.push(...await persistTaskContentNotifications({db:tx,taskId:task.id,actorId:command.actorId,actorName:access.actor.name?.trim()||"Участник",visibility:"PUBLIC",event:command.action==="approve"?"approval":"invoice_ready",eventId:command.operationId}));
          }

          const version = task.version + (plan.changed ? 1 : 0);
          await tx.taskCommandOperation.create({
            data: {
              actorId: command.actorId,
              operationId: command.operationId,
              taskId: task.id,
              projectId: task.projectId,
              requestHash: command.requestHash,
              expectedVersion: command.expectedVersion,
              committedVersion: version,
              changed: plan.changed,
            },
          });
          // A committed transition into the group queue notifies it exactly
          // once; a no-op repeat (`changed: false`) is not a second queue entry.
          if (plan.changed && marker.state !== "SUBMITTED" && plan.nextState === "SUBMITTED" && plan.nextExecutorId === null) {
            queue.entry = {
              projectId: task.projectId,
              actorName: access.actor.name?.trim() || "Участник",
            };
          }
          return {
            ack: {
              taskId: task.id,
              projectId: task.projectId,
              version,
              state: plan.nextState,
              executorId: plan.nextExecutorId,
              changed: plan.changed,
              replayed: false,
            },
            effects: plan.changed
              ? {
                  action: command.action,
                  ...(reasonMessageId?{reasonMessageId}:{}),
                  previousState: marker.state,
                  previousExecutorId: marker.executorId,
                  state: plan.nextState,
                  executorId: plan.nextExecutorId,
                }
              : null,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
      if (queue.invalidation !== null) {
        try { await (dependencies.invalidateQueue ?? emitRequestQueueInvalidation)(queue.invalidation); }
        catch { /* Transport failure never replaces the committed command receipt. */ }
      }
      const queueEntry = queue.entry;
      if (queueEntry !== null) {
        const notify = dependencies.notifyQueueEntered ?? notifyTaskRequestQueueEntered;
        try {
          await notify({
            taskId: result.ack.taskId,
            projectId: queueEntry.projectId,
            actorId: command.actorId,
            actorName: queueEntry.actorName,
          });
        } catch {
          // Delivery is best effort; the committed ACK and receipt stand.
        }
      }
      if(contentNotifications.length)deliverNotifications(contentNotifications);
      return result;
    },

    /**
     * Read-only projection for the lifecycle controls. It uses the same fresh
     * actor/project/group policy as the command service and never mutates.
     */
    async snapshot(input: {
      actorId: string;
      taskId: string;
    }): Promise<TaskLifecycleSnapshot> {
      const { actorId, taskId } = input;
      if (!idPattern.test(actorId) || !idPattern.test(taskId)) {
        throw new TaskLifecycleError("INVALID_COMMAND");
      }
      return database.$transaction(async (tx) => {
        const identity = await tx.task.findUnique({ where: { id: taskId }, select: { id: true, projectId: true } });
        if (!identity) throw new NotFoundError();
        const projects = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Project" WHERE "id" = ${identity.projectId} FOR SHARE`;
        if (!Array.isArray(projects) || projects.length !== 1) throw new NotFoundError();
        const tasks = await tx.$queryRaw<{ id: string; projectId: string }[]>`SELECT "id", "projectId" FROM "Task" WHERE "id" = ${identity.id} FOR SHARE`;
        if (!Array.isArray(tasks) || tasks.length !== 1) throw new NotFoundError();
        if (tasks[0].projectId !== identity.projectId) throw new TaskLifecycleError("IDENTITY_CHANGED");
        const task = await tx.task.findUnique({
          where: { id: taskId },
          select: {
            id: true,
            projectId: true,
            version: true,
            createdById: true,
            attachments: true,
          },
        });
        if (!task) throw new NotFoundError();
        const access = await freshAccess(tx, actorId, task.id, task.projectId);
        const row = await tx.taskRequest.findUnique({
          where: { taskId },
          select: { ...markerSelection, deletedAt: true },
        });
        let marker: TaskRequestMarker | null = null;
        let deleted = false;
        if (row !== null) {
          const { deletedAt, ...fields } = row;
          deleted = deletedAt !== null && deletedAt !== undefined;
          const decoded = decodeStoredTaskRequest(fields, taskId);
          if (!decoded.valid) {
            throw new TaskLifecycleError("INVALID_REQUEST_MARKER");
          }
          marker = decoded.marker;
        }
        // A draft stays the author's private area; a global administrator
        // keeps the agreed full-read exception.
        if (
          marker !== null &&
          marker.state === "DRAFT" &&
          marker.authorId !== actorId &&
          access.actor.globalRole !== "ADMIN"
        ) {
          throw new NotFoundError();
        }
        const business=await readBeznalBusinessState(tx,task.id,task.projectId);
        const authorId = marker?.authorId ?? task.createdById;
        const executorId = marker?.executorId ?? null;
        const executorUser = executorId === null
          ? null
          : await tx.user.findUnique({
              where: { id: executorId },
              select: { name: true, email: true },
            });
        const isAuthor = authorId !== null && authorId === actorId;
        const isExecutor = executorId !== null && executorId === actorId;
        const isLeader = access.canManageMembers;
        // Marked requests deliberately cannot use the legacy scalar/assignee
        // writers. Expose only operations implemented by the canonical service;
        // do not turn board visibility or execution membership into write rights.
        const legacyAccess = marker === null ? await getProjectAccess(access.actor, task.projectId, tx) : null;
        const canEditFields = !deleted && legacyAccess?.canWrite === true;
        const legacyAssignees = canEditFields ? await tx.taskAssignee.findMany({ where: { taskId }, select: { userId: true }, take: 2 }) : [];
        const canEditDescription = !deleted && (marker === null ? canEditFields : planTaskRequestTransition(marker,
          factsFrom(actorId, access, marker.authorId, marker.executorId), { action: "edit_description", description: null }).allowed);
        const legacyAssignmentAllowed = access.actor.globalRole === "ADMIN"
          || !ownTaskProjectIds(process.env.LENKANBAN_OWN_TASK_PROJECT_IDS).includes(task.projectId);
        const canUseLegacyAssignees = canEditFields && legacyAssignmentAllowed && (legacyAccess?.canManageMembers === true
          || (await getProjectStatusPolicy(access.actor, task.projectId, tx)).canChangeStatus);
        const permissions: TaskLifecyclePermissions = {
          isAuthor,
          isExecutor,
          isLeader,
          isGroupMember: access.isGroupMember,
          canParticipate: access.canParticipate,
          canExecute: access.canExecute,
          canAssign:
            (isLeader || isExecutor) && access.canExecute,
          isResponsibleGroupLeader: access.isResponsibleGroupLeader,
          canReturnForRevision: !deleted&&business.enabled&&["SUBMITTED","IN_PROGRESS","NEEDS_INFO","COMPLETED","CLOSED"].includes(marker?.state??"")&&(isAuthor||access.canReturnForRevision||access.canApprove)&&(business.phase==="INVOICED"||["COMPLETED","CLOSED","NEEDS_INFO"].includes(marker?.state??"")),
          canApprove: !deleted&&business.enabled&&business.phase==="INVOICED"&&["SUBMITTED","IN_PROGRESS","NEEDS_INFO"].includes(marker?.state??"")&&(isAuthor||access.canApprove),
          canMarkInvoiceReady: !deleted&&business.enabled&&business.phase==="WAITING"&&["IN_PROGRESS","NEEDS_INFO"].includes(marker?.state??"")&&isExecutor&&access.canExecute,
          canClose: !business.enabled && (marker?.state === "COMPLETED" || marker?.state === "CLOSED") && ((isExecutor && access.canExecute) || access.isResponsibleGroupLeader),
          canEditFields,
          canEditDescription,
          canSetDeadline: canEditFields && legacyAssignees.length === 1 && legacyAssignees[0].userId === actorId,
          canUseLegacyAssignees,
        };
        const attachments: TaskLifecycleAttachmentView[] = [];
        const visibleAttachments = await filterTaskAttachmentsForReader(
          tx, access.actor, task.projectId, parseStoredAttachments(task.attachments),
        );
        for (const attachment of visibleAttachments) {
          const id = parseAttachmentFileUrl(attachment.url, taskId);
          if (id === null) continue;
          attachments.push({
            id,
            name: attachment.name,
            size: attachment.size,
            mime: attachment.mime,
          });
        }
        return {
          taskId: task.id,
          workflowKind: business.enabled?"beznal":"default",
          beznalPhase: business.phase,
          invoiceFiles: permissions.canMarkInvoiceReady ? publicTaskAttachmentDTOs(task.attachments).filter(file=>parseAttachmentFileUrl(file.url,taskId)!==null).map(file=>({url:file.url,name:file.name})) : [],
          isPersonal: Boolean(access.audience?.audienceUserIds.length),
          projectId: task.projectId,
          version: task.version,
          marked: marker !== null,
          deleted,
          state: marker?.state ?? null,
          authorId,
          executorId,
          executorName:
            executorUser?.name?.trim() || executorUser?.email || null,
          permissions,
          assignees: permissions.canAssign
            ? await eligibleAssignees(tx, task.projectId, access.audience)
            : null,
          attachments,
        };
      });
    },
  };
}
