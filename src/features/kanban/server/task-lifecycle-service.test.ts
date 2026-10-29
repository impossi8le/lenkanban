import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/app/api/tasks/[id]/messages/discussion-notifications",()=>({persistTaskContentNotifications:vi.fn(async()=>[])}));
vi.mock("@/lib/logger", () => ({ dbLogger: { error: vi.fn() } }));
vi.mock("@/socket/request-queue-events", () => ({ emitRequestQueueInvalidation: vi.fn(async () => {}) }));
vi.mock("@/lib/project-access", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/project-access")>();
  return { ...actual, getProjectAccess: vi.fn(actual.getProjectAccess) };
});
import { getProjectAccess } from "@/lib/project-access";
afterEach(() => { vi.mocked(getProjectAccess).mockReset(); vi.unstubAllEnvs(); });

import type { TaskRequestState } from "@/lib/task-request-policy";
import {
  authorizeTaskRequestContentWrite,
  commitBeznalContentEffect,
  authorizeTaskAttachmentDetach,
  createTaskLifecycleService,
  deleteTaskLifecycleAware,
  TaskLifecycleError,
  type TaskLifecycleCommandInput,
} from "./task-lifecycle-service";
import { NotFoundError } from "@/lib/errors";

interface MarkerRow {
  taskId: string;
  contractVersion: number;
  state: TaskRequestState;
  authorId: string;
  executorId: string | null;
  needsInfoSince?: Date | null;
  pausedTotalMs?: number;
  deletedAt?: Date | null;
}

interface ReceiptRow {
  actorId: string;
  operationId: string;
  taskId: string;
  projectId: string;
  requestHash: string;
  expectedVersion: number;
  committedVersion: number;
  changed: boolean;
}

const projectId = "project";
const taskId = "task";
const columnId = "column";

function fixture(initialState: TaskRequestState = "DRAFT") {
  const task: {
    id: string;
    projectId: string;
    columnId: string;
    version: number;
    status: string;
    rank: string;
    position: number;
    description: string | null;
    createdById: string | null;
  } = {
    id: taskId,
    projectId,
    columnId,
    version: 3,
    status: "TODO", rank: "0|00000000000000000010", position: 1024,
    description: "old description",
    createdById: "author",
  };
  const markers = new Map<string, MarkerRow>();
  markers.set(taskId, {
    taskId,
    contractVersion: 1,
    state: initialState,
    authorId: "author",
    executorId: ["IN_PROGRESS", "NEEDS_INFO", "COMPLETED", "CLOSED"].includes(initialState)
      ? "executor"
      : null,
    needsInfoSince: null,
    pausedTotalMs: 0,
    deletedAt: null,
  });
  const receipts = new Map<string, ReceiptRow>();
  const queue = { epoch: 0, seen: new Set<string>() };
  const activities: Record<string, unknown>[] = [];
  const writes: string[] = [];
  const members = [
    { userId: "author", role: "MEMBER" as const },
    { userId: "executor", role: "MEMBER" as const },
    { userId: "member", role: "MEMBER" as const },
  ];
  const options = {
    beznal:false,
    beznalPhase:"WAITING" as "WAITING"|"INVOICED"|null,
    currentInvoiceUrl:null as string|null,
    returnRoleIds:[] as string[],
    approveRoleIds:[] as string[],
    attachmentPending:false,
    lifecycleMap: { contractVersion: 1 as const, submittedColumnId: "new-column", inProgressColumnId: "working-column", needsInfoColumnId: "waiting-column", completedColumnId: "resolved-column", closedColumnId: "closed-column" } as import("@/lib/task-request-columns").LifecycleColumnMap | null,
    markerMalformed: false,
    actorMissing: false,
    executorActive: true,
    markerCasFailure: false,
    taskCasFailure: false,
    receiptCorrupt: false,
    watcher: false,
    taskReader: true,
    groupMembers: ["executor"] as string[],
    groupArchived: false,
    groupLeaderId: null as string | null,
    blockedIds: [] as string[],
    blockedAtOnlyIds: [] as string[],
    departmentLeaderId: "leader" as string | null,
    departmentArchived: false,
    departmentBound: true,
    departmentStaff: null as string[] | null,
    executionDeniedIds: [] as string[],
    manageRoleIds: [] as string[],
    attachmentInternal: false,
    audienceUserIds: [] as string[],
    missingColumnId: null as string | null,
    columnProjectId: projectId,
  };
  const notifyQueue = vi.fn(async () => []);
  const invalidateQueue = vi.fn(async () => {});

  function roleRows(ids: string[]) {
    return ids.filter(id => !options.executionDeniedIds.includes(id)||options.returnRoleIds.includes(id)||options.approveRoleIds.includes(id)).map(userId => ({ id: `execute-${userId}`, userId, profileId: "execution", scopeKind: "board", departmentId: null, projectId,
      profile: { archivedAt: null, permissions: [...(options.approveRoleIds.includes(userId)?["request.approve"]:[]),...(!options.executionDeniedIds.includes(userId)?["request.execute"]:[]),...(options.returnRoleIds.includes(userId)?["request.return_for_revision","request.read.common"]:[]), ...(options.manageRoleIds.includes(userId) ? ["request.manage"] : [])].sort() } }));
  }
  const tx = {
    scopedPrivilegeAssignment: { findMany: vi.fn(async ({ where }: { where: { userId: string | { in: string[] }; id?: { in: string[] } } }) => roleRows(typeof where.userId === "string" ? [where.userId] : where.userId.in).filter(row => !where.id || where.id.in.includes(row.id))) },
    $queryRaw: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join("?");
      if (sql.includes('FROM "ScopedPrivilegeAssignment"')) return roleRows(values[0] as string[]).map(row => ({ id: row.id }));
      if (sql.includes('FROM "GroupPrivilegeAssignment"')) return [];
      if (sql.includes("pg_advisory")) return [{ locked: "1" }];
      if (sql.includes('FROM "ProjectColumn"')) return values[0] === options.missingColumnId ? [] : [{ id: values[0], projectId: options.columnProjectId, workflowKey: values[0] === "closed-column" ? "DONE" : values[0] === "resolved-column" ? "REVIEW" : values[0] === "working-column" ? "IN_PROGRESS" : values[0] === "waiting-column" ? "COLUMN_waiting" : "TODO" }];
      if (sql.includes('FROM "Project"')) return [{ id: values[0] }];
      if (sql.includes('FROM "TaskRequest"')) {
        return markers.has(taskId) ? [{ taskId }] : [];
      }
      if (sql.includes('FROM "TaskWatcher"')) {
        return options.watcher ? [{ userId: values[1] }] : [];
      }
      if (sql.includes('FROM "Task"')) return [{ ...task }];
      if (sql.includes('FROM "ResponsibleGroup"')) return [{ id: "group", leaderId: options.groupLeaderId, archivedAt: options.groupArchived ? new Date() : null }];
      if (sql.includes('FROM "ResponsibleGroupMember"')) return options.groupMembers.includes(String(values[1])) ? [{ userId: values[1] }] : [];
      if (sql.includes('FROM "Department"')) return options.departmentBound ? [{ id: "department" }] : [];
      if (sql.includes('FROM "User"')) return [{ id: values[0] }];
      throw new Error("Unexpected fixture query");
    }),
    task: {
      findFirst: vi.fn(async (input: {select: {id?: boolean; rank?: boolean; position?: boolean; request?: unknown}}) => {
        if (input.select.request) {
          const marker = markers.get(taskId);
          return marker && marker.state !== "DRAFT" && marker.deletedAt == null
            ? { request: { authorId: marker.authorId, audienceUserIds: options.audienceUserIds } } : null;
        }
        return input.select.id ? options.taskReader ? { id: taskId } : null : input.select.rank ? {rank: "0|00000000000000000010"} : {position: 1024};
      }),
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => ({
        id: taskId,
        projectId,
        columnId: task.columnId,
        version: task.version,
        createdById: task.createdById,
        attachments: [{
          url: `/api/tasks/${taskId}/files/0a6e3b9e-3dcb-402e-891a-d1074b75d40f`,
          name: "answer.pdf",
          size: 4,
          mime: "application/pdf",
          ...(options.attachmentInternal ? { isInternal: true } : {}),
          ...(options.attachmentPending ? {pendingMessageAuthorId:"executor"}:{}),
        }],
      })),
      updateMany: vi.fn(async (input: {
        where: { id: string; projectId: string; columnId: string; version: number };
        data: Prisma.TaskUncheckedUpdateManyInput;
      }) => {
        writes.push("task");
        if (
          options.taskCasFailure ||
          input.where.id !== task.id ||
          input.where.projectId !== task.projectId ||
          input.where.columnId !== task.columnId ||
          input.where.version !== task.version
        ) {
          return { count: 0 };
        }
        if (input.data.description !== undefined) {
          task.description = input.data.description as string | null;
        }
        if (typeof input.data.columnId === "string") task.columnId = input.data.columnId;
        if (typeof input.data.status === "string") task.status = input.data.status;
        if (typeof input.data.rank === "string") task.rank = input.data.rank;
        if (typeof input.data.position === "number") task.position = input.data.position;
        const version = input.data.version as { increment: number } | undefined;
        if (version) task.version += version.increment;
        return { count: 1 };
      }),
    },
    taskRequest: {
      findUnique: vi.fn(async (input?: { select?: { deletedAt?: boolean; audienceUserIds?: boolean; beznalPhase?:boolean } }) => {
        if (input?.select?.beznalPhase) return {beznalPhase:options.beznalPhase} as never;
        if (input?.select?.audienceUserIds) return markers.has(taskId) ? { authorId: markers.get(taskId)!.authorId, audienceUserIds: options.audienceUserIds } : null;
        if (options.markerMalformed) {
          return { taskId, contractVersion: 2, state: "DRAFT", authorId: "author", executorId: null, ...(input?.select?.deletedAt ? { deletedAt: null } : {}) };
        }
        const stored = markers.get(taskId);
        if (!stored) return null;
        const { deletedAt, ...fields } = stored;
        return input?.select?.deletedAt ? { ...fields, deletedAt: deletedAt ?? null } : fields;
      }),
      updateMany: vi.fn(async (input: {
        where: { taskId: string; state: TaskRequestState; executorId: string | null; queueEpoch?: { lt: number } };
        data: { beznalPhase?:"WAITING"|"INVOICED";currentInvoiceUrl?:string|null;state?: TaskRequestState; executorId?: string | null; queueEpoch?: { increment: number }; needsInfoSince?: Date | null; pausedTotalMs?: { increment: number } };
      }) => {
        if (input.data.queueEpoch) {
          const current = markers.get(input.where.taskId);
          if (!current || current.state !== input.where.state || current.executorId !== input.where.executorId
            || !input.where.queueEpoch || queue.epoch >= input.where.queueEpoch.lt) return { count: 0 };
          queue.epoch += input.data.queueEpoch.increment;
          writes.push("queue-epoch");
          return { count: 1 };
        }
        writes.push("marker");
        if (options.markerCasFailure) return { count: 0 };
        const current = markers.get(input.where.taskId);
        if (
          !current ||
          current.state !== input.where.state ||
          current.executorId !== input.where.executorId
        ) {
          return { count: 0 };
        }
        if(input.data.beznalPhase!==undefined)options.beznalPhase=input.data.beznalPhase;
        if(input.data.currentInvoiceUrl!==undefined)options.currentInvoiceUrl=input.data.currentInvoiceUrl;
        if(input.data.state!==undefined)current.state = input.data.state;
        if(input.data.executorId!==undefined)current.executorId = input.data.executorId;
        if (input.data.needsInfoSince !== undefined) current.needsInfoSince = input.data.needsInfoSince;
        if (input.data.pausedTotalMs) current.pausedTotalMs = (current.pausedTotalMs ?? 0) + input.data.pausedTotalMs.increment;
        return { count: 1 };
      }),
      create: vi.fn(async ({ data }: { data: MarkerRow }) => {
        writes.push("marker-create");
        markers.set(data.taskId, structuredClone(data));
        return data;
      }),
    },
    taskRequestQueueSeen: {
      deleteMany: vi.fn(async () => { const count = queue.seen.size; queue.seen.clear(); writes.push("queue-seen-clear"); return { count }; }),
      createMany: vi.fn(async ({ data }: { data: { taskId: string; userId: string }[] }) => {
        let count = 0;
        for (const row of data) if (!queue.seen.has(row.userId)) { queue.seen.add(row.userId); count++; }
        writes.push("queue-seen"); return { count };
      }),
    },
    user: {
      findMany: vi.fn(async ({ where }: { where: Prisma.UserWhereInput }) => {
        const ids = options.departmentBound ? options.departmentArchived ? [] : options.departmentStaff ?? [...options.groupMembers, ...(options.departmentLeaderId ? [options.departmentLeaderId] : [])] : options.groupArchived ? [] : options.groupMembers;
        void where;
        return [...new Set(ids)].filter(id => !options.blockedIds.includes(id) && !options.blockedAtOnlyIds.includes(id) && (id !== "executor" || options.executorActive)).map(id => ({ id, name: id, email: `${id}@example.test` }));
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (options.actorMissing && where.id === "author") return null;
        if (where.id === "executor" && !options.executorActive) return null;
        if (["author", "executor", "member", "leader", "admin", "stranger", "outsider"].includes(where.id)) {
          return {
            id: where.id,
            globalRole: where.id === "admin" ? ("ADMIN" as const) : ("USER" as const),
            name: where.id === "executor" ? "Executor" : null,
            isBlocked: options.blockedIds.includes(where.id),
            blockedAt: options.blockedIds.includes(where.id) || options.blockedAtOnlyIds.includes(where.id) ? new Date() : null,
            email: `${where.id}@example.test`,
            primaryDepartmentId: (options.departmentStaff ?? [...options.groupMembers, ...(options.departmentLeaderId ? [options.departmentLeaderId] : [])]).includes(where.id) ? "department" : "other-department",
          };
        }
        return null;
      }),
    },
    project: {
      update: vi.fn(async () => ({ boardRevision: 1 })),
      findUnique: vi.fn(async (input: {
        select: {
          name?:boolean;
          owner?: unknown;
          members?: { where?: { userId: string } };
          responsibleGroup?: { select: { members: { where?: { userId: string } } } };
          department?: unknown;
          departmentId?: boolean;
          lifecycleColumnMap?: boolean;
          responsibleGroupId?: boolean;
        };
      }) => {
        if(input.select.name)return {name:options.beznal?"Безнал ОП":"Техподдержка"} as never;
        if (input.select.departmentId) return {
          departmentId: options.departmentBound ? "department" : null,
          department: options.departmentBound ? { id: "department", archivedAt: options.departmentArchived ? new Date() : null } : null,
          responsibleGroupId: "group", responsibleGroup: { archivedAt: options.groupArchived ? new Date() : null },
        };
        if (input.select.responsibleGroupId) return { responsibleGroupId: "group" };
        if (input.select.lifecycleColumnMap) return { lifecycleColumnMap: options.lifecycleMap };
        if (input.select.department && !input.select.members) {
          return { department: !options.departmentBound ? null : {
            id: "department",
            leaderId: options.departmentLeaderId,
            archivedAt: options.departmentArchived ? new Date() : null,
          } };
        }
        // Candidate projection for the lifecycle snapshot.
        if (input.select.owner) {
          return {
            owner: { id: "leader", name: "Leader", email: "leader@example.test" },
            members: [{ role: "MEMBER" as const, user: { id: "member", name: "Member", email: "member@example.test" } }],
            responsibleGroup: {
              archivedAt: null,
              members: [{ user: { id: "executor", name: "Executor", email: "executor@example.test" } }],
            },
          };
        }
        if (input.select.responsibleGroup && !input.select.members) {
          const userId = input.select.responsibleGroup.select.members.where?.userId ?? "";
          return {
            responsibleGroup: options.groupArchived
              ? { archivedAt: new Date("2026-01-01T00:00:00Z"), members: [] }
              : {
                  archivedAt: null,
                   members: userId
                     ? options.groupMembers.includes(userId) ? [{ userId }] : []
                     : options.groupMembers.map(id => ({ user: { id, name: id, email: `${id}@example.test` } })),
                },
          };
        }
        const userId = input.select.members?.where?.userId ?? "";
        if (userId === "executor" && !options.executorActive) {
          return { id: projectId, ownerId: "leader", members: [] };
        }
        const membership = members.find((member) => member.userId === userId);
        return {
          id: projectId,
          ownerId: "leader",
          department: options.departmentBound ? { id: "department", archivedAt: options.departmentArchived ? new Date() : null } : null,
          members: membership ? [{ role: membership.role }] : [],
          responsibleGroup: { archivedAt: options.groupArchived ? new Date() : null, members: options.groupMembers.includes(userId) ? [{ userId }] : [] },
        };
      }),
    },
    activity: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.push("activity");
        activities.push(structuredClone(data));
        return data;
      }),
    },
    taskCommandOperation: {
      findUnique: vi.fn(async ({ where }: {
        where: { actorId_operationId: { actorId: string; operationId: string } };
      }) => {
        const { actorId, operationId } = where.actorId_operationId;
        const row = receipts.get(`${actorId}/${operationId}`);
        if (!row) return null;
        const copy = { ...row };
        if (options.receiptCorrupt) copy.committedVersion = 99;
        return copy;
      }),
      create: vi.fn(async ({ data }: { data: ReceiptRow }) => {
        writes.push("receipt");
        receipts.set(`${data.actorId}/${data.operationId}`, structuredClone(data));
        return data;
      }),
    },
    taskAssignee: {
      findMany: vi.fn(async (): Promise<{ userId: string }[]> => []),
      deleteMany: vi.fn(async () => {
        writes.push("assignee-clear");
        return { count: 1 };
      }),
      create: vi.fn(async ({ data }: { data: { taskId: string; userId: string } }) => {
        writes.push("assignee");
        return data;
      }),
    },
    chatMessage: {
      create:vi.fn(async()=>({id:"reason-message"})),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (
        where.id === "comment" ? { taskId, authorId: "author" } : null
      )),
    },
  };

  const transaction = vi.fn(async (
    operation: (client: typeof tx) => Promise<unknown>,
  ) => operation(tx));
  const service = createTaskLifecycleService(
    { $transaction: transaction } as unknown as Parameters<typeof createTaskLifecycleService>[0],
    { notifyQueueEntered: notifyQueue, invalidateQueue },
  );
  const input = (
    overrides: Partial<TaskLifecycleCommandInput> = {},
  ): TaskLifecycleCommandInput => ({
    actorId: "author",
    taskId,
    operationId: randomUUID(),
    expectedVersion: task.version,
    action: "submit",
    ...overrides,
  });
  return {
    service,
    tx,
    transaction,
    task,
    markers,
    queue,
    receipts,
    activities,
    writes,
    options,
    notifyQueue,
    invalidateQueue,
    input,
    setMarker: (row: MarkerRow | null) => {
      if (row === null) markers.delete(taskId);
      else markers.set(taskId, row);
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

describe("queue arrival epoch inside the canonical lifecycle transaction", () => {
  it("keeps pre-launch queue requests at zero on reads and ordinary description edits", async () => {
    const f = fixture("SUBMITTED");
    await f.service.snapshot({ actorId: "author", taskId });
    await f.service.transition(f.input({ action: "edit_description", description: "Updated existing request" }));
    expect(f.queue.epoch).toBe(0);
    expect(f.queue.seen.size).toBe(0);
    expect(f.tx.taskRequestQueueSeen.deleteMany).not.toHaveBeenCalled();
    expect(f.notifyQueue).not.toHaveBeenCalled();
    expect(f.invalidateQueue).not.toHaveBeenCalled();
  });
  it("creates one arrival with self-seen on submit, never on receipt replay or no-op", async () => {
    const f = fixture(); const command = f.input();
    await f.service.transition(command);
    expect(f.queue.epoch).toBe(1);
    expect([...f.queue.seen]).toEqual(["author"]);
    expect(f.writes.indexOf("queue-epoch")).toBeGreaterThan(f.writes.indexOf("task"));
    await f.service.transition(command);
    await f.service.transition(f.input());
    expect(f.queue.epoch).toBe(1);
    expect(f.tx.taskRequestQueueSeen.deleteMany).toHaveBeenCalledOnce();
    expect(f.tx.taskRequestQueueSeen.createMany).toHaveBeenCalledExactlyOnceWith({ data: [{ taskId, userId: "author" }], skipDuplicates: true });
    expect(f.invalidateQueue).toHaveBeenCalledExactlyOnceWith({ taskId, projectId, previousRecipientIds: [] });
  });
  it("increments and clears old viewers only when reopen returns to the common queue", async () => {
    const f = fixture("CLOSED"); f.queue.epoch = 4; f.queue.seen.add("member");
    f.options.executorActive = false;
    const command = f.input({ action: "reopen", reason: "Synthetic return" });
    expect((await f.service.transition(command)).ack).toMatchObject({ state: "SUBMITTED", executorId: null });
    expect(f.queue.epoch).toBe(5);
    expect([...f.queue.seen]).toEqual(["author"]);
    await f.service.transition(command);
    expect(f.queue.epoch).toBe(5);
    const assigned = fixture("CLOSED"); assigned.queue.epoch = 4;
    expect((await assigned.service.transition(assigned.input({ action: "reopen", reason: "Still assigned" }))).ack.state).toBe("IN_PROGRESS");
    expect(assigned.queue.epoch).toBe(4);
    expect(assigned.tx.taskRequestQueueSeen.deleteMany).not.toHaveBeenCalled();
  });
  it.each(["take", "assign"] as const)("does not create a second arrival or mass seen writes on %s", async action => {
    const f = fixture("SUBMITTED"); f.queue.epoch = 2; f.queue.seen.add("author");
    await f.service.transition(f.input({ action, actorId: action === "take" ? "executor" : "leader", ...(action === "assign" ? { assigneeId: "executor" } : {}) }));
    expect(f.markers.get(taskId)?.state).toBe("IN_PROGRESS");
    expect(f.queue.epoch).toBe(2);
    expect([...f.queue.seen]).toEqual(["author"]);
    expect(f.tx.taskRequestQueueSeen.createMany).not.toHaveBeenCalled();
    expect(f.invalidateQueue).toHaveBeenCalledExactlyOnceWith({ taskId, projectId, previousRecipientIds: ["executor", "leader"] });
  });
  it("does not touch arrival state when the business CAS loses", async () => {
    const f = fixture(); f.options.taskCasFailure = true;
    await expect(f.service.transition(f.input())).rejects.toMatchObject({ code: "STALE_TASK_VERSION" });
    expect(f.queue.epoch).toBe(0);
    expect(f.tx.taskRequestQueueSeen.deleteMany).not.toHaveBeenCalled();
    expect(f.invalidateQueue).not.toHaveBeenCalled();
  });
  it("invalidates only after commit and retains the ACK if transport fails", async () => {
    const f = fixture(); let committed = false;
    f.transaction.mockImplementationOnce(async run => { const result = await run(f.tx); committed = true; return result; });
    f.invalidateQueue.mockImplementationOnce(async () => {
      expect(committed).toBe(true); expect(f.receipts.size).toBe(1); throw new Error("Offline bridge");
    });
    expect((await f.service.transition(f.input())).ack).toMatchObject({ changed: true, state: "SUBMITTED", version: 4 });
    expect(f.invalidateQueue).toHaveBeenCalledOnce();
  });
  it("returns queue delete recipients to the outer caller without emitting inside its transaction", async () => {
    const f = fixture("SUBMITTED");
    const result = await deleteTaskLifecycleAware({ tx: f.tx as never, actorId: "author", taskId, expectedProjectId: projectId });
    expect(result).toMatchObject({ logical: true, changed: true, previousQueueRecipientIds: ["executor", "leader"] });
    expect(f.tx.taskRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deletedAt: expect.any(Date), deletedById: "author" }),
    }));
    expect(f.invalidateQueue).not.toHaveBeenCalled();
  });
  it("fails on INT epoch exhaustion before clearing viewers or creating a receipt", async () => {
    const f = fixture("CLOSED"); f.options.executorActive = false;
    f.queue.epoch = 2147483647; f.queue.seen.add("member");
    await expect(f.service.transition(f.input({ action: "reopen", reason: "Synthetic return" }))).rejects.toMatchObject({ code: "VERSION_EXHAUSTED" });
    expect(f.queue.epoch).toBe(2147483647);
    expect([...f.queue.seen]).toEqual(["member"]);
    expect(f.tx.taskRequestQueueSeen.deleteMany).not.toHaveBeenCalled();
    expect(f.receipts.size).toBe(0);
  });
});

describe("selected request audience authority", () => {
  it("admits a personal watcher snapshot and ordinary content without internal attachments or executor capabilities", async () => {
    const f = fixture("IN_PROGRESS"); f.options.audienceUserIds = ["executor"]; f.options.watcher = true; f.options.attachmentInternal = true;
    const snapshot = await f.service.snapshot({ actorId: "outsider", taskId });
    expect(snapshot.permissions).toMatchObject({ canParticipate: true, canExecute: false, canAssign: false, canClose: false, canEditFields: false, canEditDescription: false, canSetDeadline: false, canUseLegacyAssignees: false });
    expect(snapshot.attachments).toEqual([]); expect(snapshot.assignees).toBeNull();
    await expect(f.transaction(tx => authorizeTaskRequestContentWrite({ tx: tx as never, actorId: "outsider", taskId, expectedProjectId: projectId, kind: "comment" }))).resolves.toMatchObject({ allowed: true, marked: true });
    await expect(f.service.transition(f.input({ actorId: "outsider", action: "assign", assigneeId: "executor" }))).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
    await expect(f.service.transition(f.input({ actorId: "outsider", action: "edit_description", description: "Forbidden edit" }))).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
    expect(f.writes).toEqual([]);
  });
  it("does not give an unselected personal watcher execution even when the watcher belongs to the responsible group", async () => {
    const f = fixture("SUBMITTED"); f.options.audienceUserIds = ["executor"]; f.options.watcher = true; f.options.groupMembers.push("member");
    expect((await f.service.snapshot({ actorId: "member", taskId })).permissions).toMatchObject({ isGroupMember: true, canExecute: false, canAssign: false });
    await expect(f.service.transition(f.input({ actorId: "member", action: "take" }))).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
    expect(f.writes).toEqual([]);
  });
  it("rechecks the locked watcher row on snapshot/content/command and preserves other independent grants", async () => {
    const f = fixture("IN_PROGRESS"); f.options.audienceUserIds = ["executor"]; f.options.watcher = true;
    await expect(f.service.snapshot({ actorId: "outsider", taskId })).resolves.toMatchObject({ isPersonal: true });
    f.options.watcher = false;
    await expect(f.service.snapshot({ actorId: "outsider", taskId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(f.transaction(tx => authorizeTaskRequestContentWrite({ tx: tx as never, actorId: "outsider", taskId, expectedProjectId: projectId, kind: "comment" }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(f.service.transition(f.input({ actorId: "outsider", action: "complete" }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(f.service.snapshot({ actorId: "author", taskId })).resolves.toMatchObject({ authorId: "author" });
    expect(f.writes).toEqual([]);
  });
  it("admits the active destination department leader without granting selected execution or exposing audience IDs", async () => {
    const f = fixture("SUBMITTED"); f.options.audienceUserIds = ["executor"];
    const snapshot = await f.service.snapshot({ actorId: "leader", taskId });
    expect(snapshot).toMatchObject({ isPersonal: true, permissions: { canParticipate: true, canExecute: false, canAssign: false, canClose: false } });
    expect(snapshot).not.toHaveProperty("audienceUserIds");
    await expect(f.service.transition(f.input({ actorId: "leader", action: "take" }))).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
    await expect(f.service.transition(f.input({ actorId: "leader", action: "assign", assigneeId: "executor" }))).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
    await expect(f.transaction(tx => authorizeTaskRequestContentWrite({ tx: tx as never, actorId: "leader", taskId, expectedProjectId: projectId, kind: "comment" }))).resolves.toMatchObject({ allowed: true, marked: true });
    expect(f.writes).toEqual([]);
  });
  it.each(["archived", "revoked", "other-department"])("denies a department leader's personal read after %s", async denial => {
    const f = fixture("SUBMITTED"); f.options.audienceUserIds = ["executor"];
    if (denial === "archived") f.options.departmentArchived = true;
    else f.options.departmentLeaderId = denial === "revoked" ? null : "other-leader";
    await expect(f.service.snapshot({ actorId: "leader", taskId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(f.transaction(tx => authorizeTaskRequestContentWrite({ tx: tx as never, actorId: "leader", taskId, expectedProjectId: projectId, kind: "comment" }))).rejects.toBeInstanceOf(NotFoundError);
    expect(f.writes).toEqual([]);
  });
  it("lets the current responsible-group leader read while all execution controls remain denied", async () => {
    const f = fixture("SUBMITTED"); f.options.audienceUserIds = ["executor"];
    f.options.groupMembers.push("member"); f.options.groupLeaderId = "member";
    expect((await f.service.snapshot({ actorId: "member", taskId })).permissions).toMatchObject({ canParticipate: true, canExecute: false, canAssign: false, canClose: false });
    await expect(f.service.transition(f.input({ actorId: "member", action: "take" }))).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
    await expect(f.service.transition(f.input({ actorId: "member", action: "assign", assigneeId: "executor" }))).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
    expect(f.writes).toEqual([]);
  });
  it.each(["archived", "removed-membership", "other-leader"])("rejects selected audience leader access after %s", async denial => {
    const f = fixture("IN_PROGRESS"); f.options.audienceUserIds = ["executor"];
    f.options.groupMembers.push("member"); f.options.groupLeaderId = "member";
    if (denial === "archived") f.options.groupArchived = true;
    if (denial === "removed-membership") f.options.groupMembers = ["executor"];
    if (denial === "other-leader") f.options.groupLeaderId = "executor";
    await expect(f.service.snapshot({ actorId: "member", taskId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(f.transaction(tx => authorizeTaskRequestContentWrite({ tx: tx as never, actorId: "member", taskId, expectedProjectId: projectId, kind: "comment" }))).rejects.toBeInstanceOf(NotFoundError);
    expect(f.writes).toEqual([]);
  });
  it("passes current locked leader facts to the ordinary content policy", async () => {
    const f = fixture("IN_PROGRESS"); f.options.audienceUserIds = ["executor"];
    f.options.groupMembers.push("member"); f.options.groupLeaderId = "member";
    await expect(f.transaction(tx => authorizeTaskRequestContentWrite({ tx: tx as never, actorId: "member", taskId, expectedProjectId: projectId, kind: "comment" }))).resolves.toMatchObject({ allowed: true, marked: true });
    expect(f.writes).toEqual([]);
  });
  it.each(["member", "executor"])("denies nonselected %s snapshot and mutation even if a common-read double allows it", async actorId => {
    const f = fixture("IN_PROGRESS"); f.options.audienceUserIds = ["outsider"];
    await expect(f.service.snapshot({ actorId, taskId })).rejects.toBeInstanceOf(NotFoundError);
    await expect(f.service.transition(f.input({ actorId, action: "complete" }))).rejects.toBeInstanceOf(NotFoundError);
    expect(f.writes).toEqual([]); expect(f.receipts.size).toBe(0);
  });
  it("allows selected execution and preserves the current UUID/version receipt protocol", async () => {
    const f = fixture("SUBMITTED"); f.options.audienceUserIds = ["executor"];
    const command = f.input({ actorId: "executor", action: "take" });
    await expect(f.service.transition(command)).resolves.toMatchObject({ ack: { state: "IN_PROGRESS", version: 4 } });
    await expect(f.service.transition(command)).resolves.toMatchObject({ ack: { replayed: true } });
    expect(f.activities).toHaveLength(1);
  });
  it("does not turn an author who is an unselected group leader into an executor", async () => {
    const f = fixture("SUBMITTED"); f.options.audienceUserIds = ["executor"];
    f.options.groupMembers.push("author"); f.options.groupLeaderId = "author"; f.options.departmentLeaderId = "author";
    expect((await f.service.snapshot({ actorId: "author", taskId })).permissions).toMatchObject({ isAuthor: true, canExecute: false, canAssign: false, isResponsibleGroupLeader: false });
    await expect(f.service.transition(f.input({ action: "take" }))).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
    expect(f.writes).toEqual([]);
  });
  it("keeps the explicit global administrator read exception", async () => {
    const f = fixture("SUBMITTED"); f.options.audienceUserIds = ["executor"];
    await expect(f.service.snapshot({ actorId: "admin", taskId })).resolves.toMatchObject({ state: "SUBMITTED" });
  });
  it("filters assignment candidates and rejects assignment outside the audience", async () => {
    const f = fixture("IN_PROGRESS"); f.options.audienceUserIds = ["executor"]; f.options.groupMembers.push("member");
    expect((await f.service.snapshot({ actorId: "executor", taskId })).assignees?.map(user => user.id)).toEqual(["executor"]);
    await expect(f.service.transition(f.input({ actorId: "executor", action: "assign", assigneeId: "member" }))).rejects.toMatchObject({ code: "ASSIGNEE_NOT_ELIGIBLE" });
    expect(f.writes).toEqual([]);
  });
  it("returns to the selected queue rather than restoring a former executor outside the audience", async () => {
    const f = fixture("COMPLETED"); f.options.audienceUserIds = ["member"]; f.options.groupMembers.push("member");
    await f.service.transition(f.input({ action: "reopen", reason: "Needs work" }));
    expect(f.markers.get(taskId)).toMatchObject({ state: "SUBMITTED", executorId: null });
  });
  it("denies content writes outside the audience before any comment or file mutation", async () => {
    const f = fixture("IN_PROGRESS"); f.options.audienceUserIds = ["executor"];
    await expect(f.transaction(tx => authorizeTaskRequestContentWrite({ tx: tx as never, actorId: "member", taskId, expectedProjectId: projectId, kind: "comment" }))).rejects.toBeInstanceOf(NotFoundError);
    expect(f.writes).toEqual([]);
  });
});

describe("canonical lifecycle column placement", () => {
  it("closes solved requests through the active responsible group leader, distinct from department leadership", async () => {
    const f = fixture("COMPLETED");
    f.options.departmentLeaderId = null;
    f.options.groupMembers = ["executor", "member"];
    // Fixture will expose an explicit group leader independently of department.
    Object.assign(f.options, { groupLeaderId: "member" });
    await f.service.transition(f.input({ actorId: "member", action: "close" }));
    expect(f.task).toMatchObject({ columnId: "closed-column", status: "DONE", version: 4 });
    expect(f.markers.get(taskId)?.state).toBe("CLOSED");
  });
  it.each(["author", "admin", "leader", "member"])("does not grant close through the %s role alone", async actorId => {
    const f = fixture("COMPLETED");
    await expectCode(f.service.transition(f.input({ actorId, action: "close" })), "FORBIDDEN_ROLE");
    expect(f.writes).toEqual([]);
  });
  it("locks the explicit group and membership before User SHARE and exposes canClose separately", async () => {
    const f = fixture("COMPLETED"); f.options.groupLeaderId = "member"; f.options.groupMembers.push("member"); f.options.departmentLeaderId = null;
    const snapshot = await f.service.snapshot({ actorId: "member", taskId });
    expect(snapshot.permissions).toMatchObject({ isLeader: false, isResponsibleGroupLeader: true, canClose: true });
    const queries = f.tx.$queryRaw.mock.calls.map(([sql]) => sql.join("?"));
    const group = queries.findIndex(sql => sql.includes('FROM "ResponsibleGroup"'));
    const membership = queries.findIndex(sql => sql.includes('FROM "ResponsibleGroupMember"'));
    const watcher = queries.findIndex(sql => sql.includes('FROM "TaskWatcher"'));
    const user = queries.findIndex(sql => sql.includes('FROM "User"'));
    expect(group).toBeGreaterThanOrEqual(0); expect(membership).toBeGreaterThan(group); expect(watcher).toBeGreaterThan(membership); expect(user).toBeGreaterThan(watcher);
    expect(queries[group]).toContain("FOR SHARE"); expect(queries[membership]).toContain("FOR SHARE");
  });
  it.each(["leader-changed", "member-removed", "group-archived"])("denies close receipt replay after %s even while the actor remains a reader", async scenario => {
    const f = fixture("COMPLETED"); f.options.groupLeaderId = "member"; f.options.groupMembers.push("member");
    const input = f.input({ actorId: "member", action: "close" });
    await f.service.transition(input); const writes = [...f.writes];
    if (scenario === "leader-changed") f.options.groupLeaderId = null;
    if (scenario === "member-removed") f.options.groupMembers = ["executor"];
    if (scenario === "group-archived") f.options.groupArchived = true;
    await expectCode(f.service.transition(input), "FORBIDDEN_ROLE");
    await expectCode(f.service.transition(f.input({ actorId: "member", action: "close" })), "FORBIDDEN_ROLE");
    expect(f.writes).toEqual(writes);
  });
  it("closes once and treats both exact replay and a new close command on CLOSED as no-ops", async () => {
    const f = fixture("COMPLETED"), input = f.input({ actorId: "executor", action: "close" });
    await f.service.transition(input);
    expect((await f.service.transition(input)).ack.replayed).toBe(true);
    expect((await f.service.transition(f.input({ actorId: "executor", action: "close" }))).ack).toMatchObject({ state: "CLOSED", changed: false, version: 4 });
    expect(f.activities).toHaveLength(1); expect(f.tx.project.update).toHaveBeenCalledOnce();
  });
  it("does not let a still-global-ADMIN replay an old group-leader close after leadership revocation", async () => {
    const f = fixture("COMPLETED"); f.options.groupLeaderId = "admin"; f.options.groupMembers.push("admin");
    const input = f.input({ actorId: "admin", action: "close" }); await f.service.transition(input);
    const writes = [...f.writes]; f.options.groupLeaderId = null;
    await expectCode(f.service.transition(input), "FORBIDDEN_ROLE"); expect(f.writes).toEqual(writes);
  });
  it("rejects a blocked ADMIN who otherwise holds the explicit group leader role", async () => {
    const f = fixture("COMPLETED"); f.options.groupLeaderId = "admin"; f.options.groupMembers.push("admin"); f.options.blockedIds.push("admin");
    await expect(f.service.transition(f.input({ actorId: "admin", action: "close" }))).rejects.toMatchObject({ name: "NotFoundError" });
    expect(f.writes).toEqual([]);
  });
  it.each(["available", "removed", "blocked", "blocked-at-only"])("reopens CLOSED by its author with reason and a freshly %s executor", async availability => {
    const f = fixture("CLOSED");
    if (availability === "removed") f.options.groupMembers = [];
    if (availability === "blocked") f.options.blockedIds = ["executor"];
    if (availability === "blocked-at-only") f.options.blockedAtOnlyIds = ["executor"];
    await expect(async () => f.service.transition(f.input({ action: "reopen" }))).rejects.toMatchObject({ code: "INVALID_COMMAND" });
    await f.service.transition(f.input({ action: "reopen", reason: "Synthetic reason" }));
    expect(f.task.columnId).toBe(availability === "available" ? "working-column" : "new-column");
    expect(f.markers.get(taskId)).toMatchObject({ state: availability === "available" ? "IN_PROGRESS" : "SUBMITTED", executorId: availability === "available" ? "executor" : null });
  });
  it.each(["blocked", "blocked-at-only"])("refuses a %s actor even when executor facts otherwise permit close", async blocked => {
    const f = fixture("COMPLETED");
    if (blocked === "blocked") f.options.blockedIds = ["executor"]; else f.options.blockedAtOnlyIds = ["executor"];
    await expect(f.service.transition(f.input({ actorId: "executor", action: "close" }))).rejects.toMatchObject({ name: "NotFoundError" });
    expect(f.writes).toEqual([]);
  });
  it("places a clarification and its answer in the explicitly configured columns", async () => {
    const f = fixture("IN_PROGRESS");
    await f.service.transition(f.input({ actorId: "executor", action: "request_info" }));
    expect(f.task.columnId).toBe("waiting-column");
    await f.service.transition(f.input({ action: "answer_info", response: { commentId: "comment" } }));
    expect(f.task.columnId).toBe("working-column");
  });
  it("fails before marker/bootstrap/receipt writes when explicit mapping is absent", async () => {
    const f = fixture(); f.options.lifecycleMap = null; f.setMarker(null);
    await expectCode(f.service.transition(f.input()), "LIFECYCLE_COLUMNS_REQUIRED");
    expect(f.writes).toEqual([]);
  });
  it("completes into the configured solved column and replays without a second placement", async () => {
    const f = fixture("IN_PROGRESS"), input = f.input({ actorId: "executor", action: "complete" });
    await f.service.transition(input);
    expect(f.task).toMatchObject({ columnId: "resolved-column", status: "IN_REVIEW", version: 4 });
    const writes = [...f.writes];
    expect((await f.service.transition(input)).ack.replayed).toBe(true);
    expect(f.writes).toEqual(writes);
    expect(f.tx.project.update).toHaveBeenCalledOnce();
  });
  it("checks fresh access before revealing malformed lifecycle configuration", async () => {
    const f = fixture("IN_PROGRESS");
    f.options.taskReader = false;
    f.options.lifecycleMap = { unexpected: "private-config" } as never;
    await expect(f.service.transition(f.input({ actorId: "outsider", action: "request_info" }))).rejects.toMatchObject({ name: "NotFoundError" });
    expect(f.writes).toEqual([]);
    expect(f.tx.taskRequest.findUnique).not.toHaveBeenCalled();
  });
  it.each(["missing-target", "foreign-target", "revoked-actor"])("keeps %s configuration hidden behind fresh access", async scenario => {
    const f = fixture("IN_PROGRESS");
    f.options.taskReader = false;
    if (scenario === "missing-target") f.options.missingColumnId = "waiting-column";
    if (scenario === "foreign-target") f.options.columnProjectId = "other-board";
    if (scenario === "revoked-actor") { f.options.actorMissing = true; f.options.lifecycleMap = { unexpected: "private" } as never; }
    await expect(f.service.transition(f.input({ actorId: scenario === "revoked-actor" ? "author" : "outsider", action: "request_info" }))).rejects.toMatchObject({ name: "NotFoundError" });
    expect(f.writes).toEqual([]); expect(f.tx.taskRequest.findUnique).not.toHaveBeenCalled();
  });
});

function expectCode(operation: Promise<unknown>, code: TaskLifecycleError["code"]) {
  return expect(operation).rejects.toMatchObject({ name: "TaskLifecycleError", code });
}

describe("takeover canonical transaction (mock DB)", () => {
  it.each(["IN_PROGRESS", "NEEDS_INFO"] as const)("preserves %s, placement and waiting timer; audits once and replays", async state => {
    const f = fixture(state);
    f.options.groupMembers.push("member");
    const started = state === "NEEDS_INFO" ? new Date("2026-10-27T12:00:00Z") : null;
    Object.assign(f.markers.get(taskId)!, { needsInfoSince: started, pausedTotalMs: 1234 });
    const before = { columnId: f.task.columnId, rank: f.task.rank, status: f.task.status, position: f.task.position };
    const input = f.input({ actorId: "member", action: "take_over" });
    expect((await f.service.transition(input)).ack).toMatchObject({ state, executorId: "member", changed: true });
    expect(f.markers.get(taskId)).toMatchObject({ state, executorId: "member", needsInfoSince: started, pausedTotalMs: 1234 });
    expect(f.task).toMatchObject(before);
    expect(f.tx.taskAssignee.create).toHaveBeenCalledExactlyOnceWith({ data: { taskId, userId: "member" } });
    expect(f.activities).toHaveLength(1);
    expect(f.activities[0]).toMatchObject({ action: "request_assigned", oldValue: { executorId: "executor" }, newValue: { executorId: "member", takenOver: true } });
    const replay = await f.service.transition(input);
    expect(replay.ack).toMatchObject({ replayed: true, changed: true });
    expect(replay.effects).toBeNull();
    expect(f.activities).toHaveLength(1);
  });
  it("rejects a stale takeover and read-only watcher without writes", async () => {
    const f = fixture("IN_PROGRESS");
    f.options.groupMembers.push("member");
    await expect(f.service.transition(f.input({ actorId: "member", action: "take_over", expectedVersion: 2 }))).rejects.toMatchObject({ code: "STALE_TASK_VERSION" });
    f.options.watcher = true;
    await expect(f.service.transition(f.input({ actorId: "stranger", action: "take_over" }))).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
    expect(f.writes).toEqual([]);
  });
  it("does not let an unselected colleague take over a personal request", async () => {
    const f = fixture("IN_PROGRESS");
    f.options.groupMembers.push("member");
    f.options.audienceUserIds = ["executor"];
    await expect(f.service.transition(f.input({ actorId: "member", action: "take_over" }))).rejects.toBeInstanceOf(NotFoundError);
    expect(f.writes).toEqual([]);
  });
});

describe("task lifecycle command service (mock DB, no PostgreSQL claim)", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["take", "assign"] as const)("does not derive the %s role from broad legacy writer or member-manager permissions", async action => {
    const f = fixture("SUBMITTED");
    vi.mocked(getProjectAccess).mockResolvedValueOnce({
      projectId, canRead: true, canWrite: true, canManageMembers: true,
    });
    await expectCode(f.service.transition(f.input({
      actorId: "member", action,
      ...(action === "assign" ? { assigneeId: "executor" } : {}),
    })), "FORBIDDEN_ROLE");
    expect(f.writes).toEqual([]);
    expect(f.notifyQueue).not.toHaveBeenCalled();
  });

  it("does not treat the legacy project owner as leader when the board department is archived", async () => {
    const f = fixture("SUBMITTED");
    f.options.departmentArchived = true;
    await expectCode(f.service.transition(f.input({ actorId: "leader", action: "assign", assigneeId: "executor" })), "FORBIDDEN_ROLE");
    expect(f.writes).toEqual([]);
  });

  it.each(["assign", "cancel", "delete"] as const)("closes the pause in the same marker update on %s", async action => {
    vi.useFakeTimers();
    const start = new Date("2026-10-22T10:00:00Z");
    vi.setSystemTime(new Date(start.getTime() + 2500));
    const f = fixture("NEEDS_INFO");
    const marker = f.markers.get(taskId)!;
    marker.needsInfoSince = start;
    marker.pausedTotalMs = 1000;
    await f.service.transition(f.input({
      actorId: "executor", action,
      ...(action === "assign" ? { assigneeId: "executor" } : {}),
    }));
    expect(f.markers.get(taskId)).toMatchObject({ needsInfoSince: null, pausedTotalMs: 3500 });
    expect(f.tx.taskRequest.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { taskId, state: "NEEDS_INFO", executorId: "executor" },
      data: {
        state: action === "assign" ? "IN_PROGRESS" : "CANCELLED", executorId: "executor",
        needsInfoSince: null, pausedTotalMs: { increment: 2500 },
      },
    });
  });

  it("does not grant execution or assignee eligibility through ordinary board membership", async () => {
    const f = fixture("SUBMITTED");
    await expectCode(f.service.transition(f.input({ actorId: "member", action: "take" })), "FORBIDDEN_ROLE");
    await expectCode(f.service.transition(f.input({ actorId: "leader", action: "assign", assigneeId: "member" })), "ASSIGNEE_NOT_ELIGIBLE");
    expect(f.writes).toEqual([]);
  });

  it("recognizes only the leader of this board's active department", async () => {
    const f = fixture("SUBMITTED");
    f.options.departmentLeaderId = "outsider";
    f.options.groupMembers = ["member"];
    expect((await f.service.snapshot({ actorId: "outsider", taskId })).permissions.isLeader).toBe(true);
    await f.service.transition(f.input({ actorId: "outsider", action: "assign", assigneeId: "member" }));
    expect(f.markers.get(taskId)?.executorId).toBe("member");
    const archived = fixture("SUBMITTED");
    archived.options.departmentLeaderId = "outsider";
    archived.options.departmentArchived = true;
    archived.options.taskReader = false;
    await expect(archived.service.transition(archived.input({ actorId: "outsider", action: "assign", assigneeId: "member" }))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("accumulates repeated pauses, preserving timers on replay, no-op and description edits", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-10-22T10:00:00Z");
    vi.setSystemTime(start);
    const f = fixture("IN_PROGRESS");
    f.options.groupMembers = ["executor"];
    const command = f.input({ actorId: "executor", action: "request_info" });
    await f.service.transition(command);
    expect(f.markers.get(taskId)).toMatchObject({ needsInfoSince: start, pausedTotalMs: 0 });
    vi.setSystemTime(new Date(start.getTime() + 1000));
    await f.service.transition(command);
    await f.service.transition(f.input({ actorId: "executor", action: "request_info" }));
    await f.service.transition(f.input({ action: "edit_description", description: "updated" }));
    expect(f.markers.get(taskId)).toMatchObject({ needsInfoSince: start, pausedTotalMs: 0 });
    const answer = () => f.service.transition(f.input({ action: "answer_info", response: { commentId: "comment" } }));
    await answer();
    expect(f.markers.get(taskId)).toMatchObject({ needsInfoSince: null, pausedTotalMs: 1000 });
    vi.setSystemTime(new Date(start.getTime() + 5000));
    await f.service.transition(f.input({ actorId: "executor", action: "request_info" }));
    expect(f.markers.get(taskId)).toMatchObject({ needsInfoSince: new Date(start.getTime() + 5000), pausedTotalMs: 1000 });
    vi.setSystemTime(new Date(start.getTime() + 7500));
    await answer();
    expect(f.markers.get(taskId)).toMatchObject({ needsInfoSince: null, pausedTotalMs: 3500 });
    expect(f.tx.taskRequest.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: { state: "IN_PROGRESS", executorId: "executor", needsInfoSince: null, pausedTotalMs: { increment: 2500 } },
    }));
  });
  it("submits a draft by its author with version CAS, Activity and a replay receipt", async () => {
    const f = fixture("DRAFT");
    const result = await f.service.transition(f.input());
    expect(result.ack).toMatchObject({
      taskId,
      projectId,
      version: 4,
      state: "SUBMITTED",
      executorId: null,
      changed: true,
      replayed: false,
    });
    expect(result.effects).toMatchObject({ action: "submit", previousState: "DRAFT", state: "SUBMITTED" });
    expect(f.tx.task.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: taskId, projectId, columnId, version: 3 },
      data: { columnId: "new-column", status: "TODO", rank: "0|I000000000000000000H", position: 2048, version: { increment: 1 } },
    });
    expect(f.activities).toEqual([{
      taskId,
      userId: "author",
      action: "request_submitted",
      oldValue: { state: "DRAFT", executorId: null, columnId },
      newValue: { state: "SUBMITTED", executorId: null, columnId: "new-column", status: "TODO" },
    }]);
    const receipt = [...f.receipts.values()][0];
    expect(receipt).toMatchObject({ actorId: "author", taskId, projectId, expectedVersion: 3, committedVersion: 4, changed: true });
    expect(JSON.stringify(receipt)).not.toMatch(/description|reason|comment/);
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  });

  it("rejects a submit by someone other than the author without writes", async () => {
    const f = fixture("DRAFT");
    await expectCode(f.service.transition(f.input({ actorId: "executor" })), "FORBIDDEN_ROLE");
    expect(f.writes).toEqual([]);
  });

  it("keeps exactly one executor when two group members try to take the same request", async () => {
    const f = fixture("SUBMITTED");
    f.options.groupMembers = ["member", "author"];
    const first = await f.service.transition(f.input({ actorId: "member", action: "take" }));
    expect(first.ack).toMatchObject({ state: "IN_PROGRESS", executorId: "member" });
    await expectCode(f.service.transition(f.input({ actorId: "author", action: "take" })), "INVALID_TRANSITION");
    expect(f.markers.get(taskId)).toMatchObject({ state: "IN_PROGRESS", executorId: "member" });
    expect(f.activities.filter((row) => row.action === "request_taken")).toHaveLength(1);
  });

  it("lets an active responsible-group member execute without project membership", async () => {
    const f = fixture("SUBMITTED");
    // The fixture's project lookup returns no membership for this actor.
    f.options.groupMembers = ["outsider"];
    const taken = await f.service.transition(f.input({ actorId: "outsider", action: "take" }));
    expect(taken.ack).toMatchObject({ state: "IN_PROGRESS", executorId: "outsider" });
    expect(f.tx.taskAssignee.deleteMany).toHaveBeenCalledOnce();
    expect(f.tx.taskAssignee.create).toHaveBeenCalledExactlyOnceWith({
      data: { taskId, userId: "outsider" },
    });
  });

  it("keeps the executor projection to exactly one person on assign and reopen", async () => {
    const assigned = fixture("SUBMITTED");
    assigned.options.groupMembers = ["member"];
    await assigned.service.transition(assigned.input({
      actorId: "leader",
      action: "assign",
      assigneeId: "member",
    }));
    expect(assigned.tx.taskAssignee.deleteMany).toHaveBeenCalledOnce();
    expect(assigned.tx.taskAssignee.create).toHaveBeenCalledOnce();

    const reopened = fixture("COMPLETED");
    await reopened.service.transition(reopened.input({
      action: "reopen",
      reason: "Нужно доработать",
    }));
    expect(reopened.tx.taskAssignee.deleteMany).toHaveBeenCalledOnce();
    expect(reopened.tx.taskAssignee.create).toHaveBeenCalledExactlyOnceWith({
      data: { taskId, userId: "executor" },
    });
  });

  it("fails closed when the conditional marker update loses a race", async () => {
    const f = fixture("SUBMITTED");
    f.options.groupMembers = ["member"];
    f.options.markerCasFailure = true;
    await expectCode(f.service.transition(f.input({ actorId: "member", action: "take" })), "STALE_TASK_VERSION");
    expect(f.tx.task.updateMany).not.toHaveBeenCalled();
    expect(f.activities).toEqual([]);
    expect(f.receipts.size).toBe(0);
  });

  it("lets a leader assign and an executor reassign only to an eligible group member", async () => {
    const f = fixture("SUBMITTED");
    f.options.groupMembers = ["member"];
    const assigned = await f.service.transition(f.input({
      actorId: "leader",
      action: "assign",
      assigneeId: "member",
    }));
    expect(assigned.ack).toMatchObject({ state: "IN_PROGRESS", executorId: "member" });
    await expectCode(f.service.transition(f.input({
      actorId: "author",
      action: "assign",
      assigneeId: "member",
    })), "FORBIDDEN_ROLE");
    await expectCode(f.service.transition(f.input({
      actorId: "leader",
      action: "assign",
      assigneeId: "outsider",
    })), "ASSIGNEE_NOT_ELIGIBLE");
  });

  it("pauses with the same executor, answers only with a comment/file and completes without acceptance", async () => {
    const f = fixture("IN_PROGRESS");
    const paused = await f.service.transition(f.input({ actorId: "executor", action: "request_info" }));
    expect(paused.ack).toMatchObject({ state: "NEEDS_INFO", executorId: "executor" });
    await expectCode(f.service.transition(f.input({
      actorId: "executor",
      action: "answer_info",
      response: { commentId: "comment" },
    })), "FORBIDDEN_ROLE");
    await expectCode(f.service.transition(f.input({
      actorId: "author",
      action: "answer_info",
      response: {},
    })), "INVALID_COMMAND");
    const answered = await f.service.transition(f.input({
      actorId: "author",
      action: "answer_info",
      response: { commentId: "comment" },
    }));
    expect(answered.ack).toMatchObject({ state: "IN_PROGRESS", executorId: "executor" });
    const completed = await f.service.transition(f.input({ actorId: "executor", action: "complete" }));
    expect(completed.ack).toMatchObject({ state: "COMPLETED", executorId: "executor" });
    expect(completed.effects).toMatchObject({ action: "complete", previousState: "IN_PROGRESS" });
  });

  it("accepts an answer only with this request's own comment or attachment", async () => {
    const foreignComment = fixture("NEEDS_INFO");
    await expectCode(foreignComment.service.transition(foreignComment.input({
      action: "answer_info",
      response: { commentId: "foreign-comment" },
    })), "INVALID_COMMAND");
    expect(foreignComment.markers.get(taskId)?.state).toBe("NEEDS_INFO");

    const attachment = fixture("NEEDS_INFO");
    const answered = await attachment.service.transition(attachment.input({
      action: "answer_info",
      response: { attachmentId: "0a6e3b9e-3dcb-402e-891a-d1074b75d40f" },
    }));
    expect(answered.ack).toMatchObject({ state: "IN_PROGRESS", executorId: "executor" });

    const unknownAttachment = fixture("NEEDS_INFO");
    await expectCode(unknownAttachment.service.transition(unknownAttachment.input({
      action: "answer_info",
      response: { attachmentId: "11111111-1111-4111-8111-111111111111" },
    })), "INVALID_COMMAND");
    expect(unknownAttachment.markers.get(taskId)?.state).toBe("NEEDS_INFO");
  });

  it("returns a reopened request to the available former executor or to the group", async () => {
    const f = fixture("COMPLETED");
    const reopened = await f.service.transition(f.input({
      actorId: "author",
      action: "reopen",
      reason: "Нужно доработать",
    }));
    expect(reopened.ack).toMatchObject({ state: "IN_PROGRESS", executorId: "executor" });

    const g = fixture("COMPLETED");
    g.options.executorActive = false;
    const toGroup = await g.service.transition(g.input({
      actorId: "author",
      action: "reopen",
      reason: "Исполнитель недоступен",
    }));
    expect(toGroup.ack).toMatchObject({ state: "SUBMITTED", executorId: null });
  });

  it("cancels before work by the author and after work only by executor or leader", async () => {
    const draft = fixture("DRAFT");
    expect((await draft.service.transition(draft.input({ action: "cancel" }))).ack)
      .toMatchObject({ state: "CANCELLED" });

    const after = fixture("IN_PROGRESS");
    await expectCode(after.service.transition(after.input({ actorId: "author", action: "cancel" })), "FORBIDDEN_ROLE");
    expect((await after.service.transition(after.input({ actorId: "executor", action: "cancel" }))).ack)
      .toMatchObject({ state: "CANCELLED", executorId: "executor" });

    const leaderCancel = fixture("NEEDS_INFO");
    expect((await leaderCancel.service.transition(leaderCancel.input({ actorId: "leader", action: "cancel" }))).ack)
      .toMatchObject({ state: "CANCELLED" });
  });

  it("replays the same operation without a second Activity or effect", async () => {
    const f = fixture("DRAFT");
    const command = f.input();
    const first = await f.service.transition(command);
    const replay = await f.service.transition(command);
    expect(replay).toEqual({
      ack: { ...first.ack, replayed: true },
      effects: null,
    });
    expect(f.activities).toHaveLength(1);
    expect(f.tx.task.updateMany).toHaveBeenCalledOnce();
    expect(f.tx.taskCommandOperation.create).toHaveBeenCalledOnce();
  });

  it("treats a repeated submit with a new operation as a no-op without duplicate events", async () => {
    const f = fixture("SUBMITTED");
    const result = await f.service.transition(f.input({ action: "submit" }));
    expect(result.ack).toMatchObject({ state: "SUBMITTED", version: 3, changed: false, replayed: false });
    expect(result.effects).toBeNull();
    expect(f.tx.task.updateMany).not.toHaveBeenCalled();
    expect(f.activities).toEqual([]);
    expect(f.receipts.size).toBe(1);
  });

  it("rejects a reused operation UUID with a different fingerprint", async () => {
    const f = fixture("DRAFT");
    const command = f.input();
    await f.service.transition(command);
    await expectCode(
      f.service.transition({ ...command, expectedVersion: 4 }),
      "OPERATION_ID_REUSED",
    );
    expect(f.receipts.size).toBe(1);
  });

  it("rejects stale versions, corrupt receipts and exhausted versions before mutation", async () => {
    const stale = fixture("DRAFT");
    await expectCode(stale.service.transition(stale.input({ expectedVersion: 2 })), "STALE_TASK_VERSION");
    expect(stale.writes).toEqual([]);

    const corrupt = fixture("DRAFT");
    const command = corrupt.input();
    await corrupt.service.transition(command);
    corrupt.options.receiptCorrupt = true;
    await expectCode(corrupt.service.transition(command), "INVALID_RECEIPT");

    const exhausted = fixture("DRAFT");
    exhausted.task.version = 2147483647;
    await expectCode(
      exhausted.service.transition(exhausted.input({ expectedVersion: 2147483647 })),
      "VERSION_EXHAUSTED",
    );
    expect(exhausted.writes).toEqual([]);
  });

  it("edits the description without leaving the clarification state", async () => {
    const f = fixture("NEEDS_INFO");
    const result = await f.service.transition(f.input({
      actorId: "executor",
      action: "edit_description",
      description: "Уточнённое описание",
    }));
    expect(result.ack).toMatchObject({
      state: "NEEDS_INFO",
      executorId: "executor",
      version: 4,
      changed: true,
    });
    expect(f.task.description).toBe("Уточнённое описание");
    expect(f.activities).toEqual([expect.objectContaining({ action: "description_changed" })]);
  });

  it("rejects unknown fields and refuses a markerless card to a non-author", async () => {
    const f = fixture("DRAFT");
    await expectCode(f.service.transition(f.input({
      action: "submit",
      assigneeId: "member",
    })), "INVALID_COMMAND");

    const legacy = fixture("DRAFT");
    legacy.setMarker(null);
    await expectCode(legacy.service.transition(legacy.input({
      actorId: "member",
    })), "NOT_A_REQUEST");
    expect(legacy.writes).toEqual([]);
  });

  it("activates the lifecycle from a legacy card only when its author submits", async () => {
    const legacy = fixture("DRAFT");
    legacy.setMarker(null);
    const result = await legacy.service.transition(legacy.input());
    expect(result.ack).toMatchObject({
      state: "SUBMITTED",
      executorId: null,
      changed: true,
    });
    expect(legacy.markers.get(taskId)).toMatchObject({
      taskId,
      contractVersion: 1,
      state: "SUBMITTED",
      authorId: "author",
      executorId: null,
    });
    expect(legacy.activities).toEqual([
      expect.objectContaining({ action: "request_submitted" }),
    ]);
    expect(legacy.notifyQueue).toHaveBeenCalledOnce();
  });

  it("never bootstraps a marker for a take or a cancel on an unmarked card", async () => {
    for (const action of ["take", "cancel"] as const) {
      const legacy = fixture("DRAFT");
      legacy.setMarker(null);
      await expectCode(
        legacy.service.transition(legacy.input({ action })),
        "NOT_A_REQUEST",
      );
      expect(legacy.markers.has(taskId)).toBe(false);
      expect(legacy.writes).toEqual([]);
    }
  });

  it("fails closed on a malformed marker and on identity drift", async () => {
    const malformed = fixture("DRAFT");
    malformed.options.markerMalformed = true;
    await expectCode(malformed.service.transition(malformed.input()), "INVALID_REQUEST_MARKER");
    expect(malformed.writes).toEqual([]);

    const drift = fixture("DRAFT");
    drift.tx.task.findUnique.mockResolvedValueOnce({ ...drift.task, columnId, attachments: [] });
    drift.task.columnId = "other-column";
    await expectCode(drift.service.transition(drift.input()), "IDENTITY_CHANGED");
    expect(drift.writes).toEqual([]);
  });

  it("checks fresh actor/access before any marker or receipt read", async () => {
    const f = fixture("DRAFT");
    f.options.actorMissing = true;
    await expect(f.service.transition(f.input())).rejects.toMatchObject({ name: "NotFoundError" });
    expect(f.tx.taskRequest.findUnique).not.toHaveBeenCalled();
    expect(f.tx.taskCommandOperation.findUnique).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });

  it("notifies the responsible group once per committed submit and never on a repeat", async () => {
    const f = fixture("DRAFT");
    await f.service.transition(f.input());
    expect(f.notifyQueue).toHaveBeenCalledExactlyOnceWith({
      taskId,
      projectId,
      actorId: "author",
      actorName: "Участник",
    });

    // A new operation that is a no-op must not create a second queue entry.
    const repeated = await f.service.transition(f.input({ action: "submit" }));
    expect(repeated.ack.changed).toBe(false);
    expect(f.notifyQueue).toHaveBeenCalledOnce();

    // A replay of the same operation is not a queue entry either.
    const replay = fixture("DRAFT");
    const command = replay.input();
    await replay.service.transition(command);
    await replay.service.transition(command);
    expect(replay.notifyQueue).toHaveBeenCalledOnce();
  });

  it("keeps the committed ACK when queue delivery fails", async () => {
    const f = fixture("DRAFT");
    f.notifyQueue.mockRejectedValueOnce(new Error("synthetic-private-delivery"));
    const result = await f.service.transition(f.input());
    expect(result.ack).toMatchObject({ state: "SUBMITTED", changed: true });
    expect(f.receipts.size).toBe(1);
  });

  it("does not notify for transitions that never enter the queue", async () => {
    for (const [state, action, actorId, extra] of [
      ["SUBMITTED", "take", "member", {}],
      ["IN_PROGRESS", "complete", "executor", {}],
      ["DRAFT", "cancel", "author", {}],
    ] as const) {
      const f = fixture(state as TaskRequestState);
      f.options.groupMembers = ["member", "executor"];
      await f.service.transition(f.input({ actorId, action, ...extra }));
      expect(f.notifyQueue).not.toHaveBeenCalled();
    }
  });

  it("hides a marked request from an actor outside the common policy", async () => {
    const f = fixture("DRAFT");
    f.options.taskReader = false;
    await expect(f.service.transition(f.input({ actorId: "stranger" })))
      .rejects.toBeInstanceOf(NotFoundError);
    expect(f.notifyQueue).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
  });
});

describe("lifecycle read projection", () => {
  function snapshotOf(f: Fixture, actorId: string) {
    return f.service.snapshot({ actorId, taskId });
  }
  it.each(["author", "member", "executor", "leader", "admin"])("never offers unsupported marked scalar writers to %s", async actorId => {
    const f = fixture("IN_PROGRESS");
    expect((await snapshotOf(f, actorId)).permissions).toMatchObject({ canEditFields: false, canSetDeadline: false, canUseLegacyAssignees: false });
    expect(f.writes).toEqual([]);
  });
  it.each([
    ["DRAFT", "author", true], ["DRAFT", "admin", false],
    ["SUBMITTED", "author", true], ["SUBMITTED", "member", false],
    ["IN_PROGRESS", "executor", true], ["IN_PROGRESS", "leader", false],
    ["NEEDS_INFO", "author", true], ["COMPLETED", "executor", false],
    ["CLOSED", "author", false], ["CANCELLED", "admin", false],
  ] as const)("projects description from the canonical planner for %s/%s", async (state, actorId, allowed) => {
    const f = fixture(state);
    expect((await snapshotOf(f, actorId)).permissions.canEditDescription).toBe(allowed);
    expect(f.writes).toEqual([]);
  });
  it("denies legacy editing for a task-only reader without legacy write access", async () => {
    const f = fixture(); f.setMarker(null);
    vi.mocked(getProjectAccess).mockResolvedValue({ projectId, canRead: false, canWrite: false, canManageMembers: false });
    expect((await snapshotOf(f, "author")).permissions).toMatchObject({ canEditFields: false, canEditDescription: false, canSetDeadline: false, canUseLegacyAssignees: false });
    expect(f.writes).toEqual([]);
  });
  it("retains the existing ADMIN-only legacy assignment restriction on OWN boards", async () => {
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", projectId);
    const f = fixture(); f.setMarker(null);
    vi.mocked(getProjectAccess).mockResolvedValue({ projectId, canRead: true, canWrite: true, canManageMembers: true });
    expect((await snapshotOf(f, "leader")).permissions.canUseLegacyAssignees).toBe(false);
    expect((await snapshotOf(f, "admin")).permissions.canUseLegacyAssignees).toBe(true);
  });
  it.each([[], [{ userId: "executor" }], [{ userId: "author" }], [{ userId: "author" }, { userId: "executor" }]].map(assignments => ({ assignments })))("matches legacy deadline authority to the actual sole assignment $assignments", async ({ assignments }) => {
    const f = fixture(); f.setMarker(null); f.tx.taskAssignee.findMany.mockResolvedValue(assignments);
    expect((await snapshotOf(f, "author")).permissions).toMatchObject({ canEditFields: true, canEditDescription: true,
      canSetDeadline: assignments.length === 1 && assignments[0].userId === "author" });
    expect(f.writes).toEqual([]);
  });
  it("retains author task-only read and description command without project membership", async () => {
    const f = fixture("SUBMITTED");
    vi.mocked(getProjectAccess).mockResolvedValue({ projectId, canRead: false, canWrite: false, canManageMembers: false });
    expect((await snapshotOf(f, "author")).permissions).toMatchObject({ isAuthor: true, canParticipate: true, canExecute: false });
    await f.service.transition(f.input({ action: "edit_description", description: "canonical edit" }));
    expect(f.task.description).toBe("canonical edit");
  });
  it("admits task-only watcher metadata but does not grant a status action", async () => {
    const f = fixture("SUBMITTED"); f.options.watcher = true;
    vi.mocked(getProjectAccess).mockResolvedValue({ projectId, canRead: false, canWrite: false, canManageMembers: false });
    expect((await snapshotOf(f, "outsider")).permissions).toMatchObject({ isAuthor: false, canParticipate: true, canExecute: false });
    await expectCode(f.service.transition(f.input({ actorId: "outsider", action: "take" })), "FORBIDDEN_ROLE");
    expect(f.writes).toEqual([]);
  });
  it("denies board-only read and every command after the common task grant is revoked", async () => {
    const f = fixture("SUBMITTED"); f.options.taskReader = false;
    await expect(snapshotOf(f, "member")).rejects.toBeInstanceOf(NotFoundError);
    await expect(f.service.transition(f.input({ action: "edit_description", description: "denied" }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(f.transaction(tx => deleteTaskLifecycleAware({ tx: tx as unknown as Prisma.TransactionClient, actorId: "author", taskId, expectedProjectId: projectId }))).rejects.toBeInstanceOf(NotFoundError);
    expect(f.writes).toEqual([]);
  });
  it("preserves the ADMIN deleted snapshot flag without exposing an ordinary task reader", async () => {
    const f = fixture("CANCELLED"); f.markers.get(taskId)!.deletedAt = new Date();
    expect(await snapshotOf(f, "admin")).toMatchObject({ deleted: true, state: "CANCELLED" });
    f.options.taskReader = false;
    await expect(snapshotOf(f, "author")).rejects.toBeInstanceOf(NotFoundError);
    expect(f.writes).toEqual([]);
  });
  it("uses shared Project and Task snapshot locks while write callers retain their exclusive locks", async () => {
    const read = fixture("SUBMITTED"); await snapshotOf(read, "author");
    const readLocks = read.tx.$queryRaw.mock.calls.map(([sql]) => sql.join("?")).filter(sql => sql.includes('FROM "Project"') || sql.includes('FROM "Task"'));
    expect(readLocks).toHaveLength(2); for (const sql of readLocks) { expect(sql).toContain("FOR SHARE"); expect(sql).not.toContain("FOR UPDATE"); }
    const write = fixture("SUBMITTED"); await write.service.transition(write.input({ action: "edit_description", description: "value" }));
    const writeLocks = write.tx.$queryRaw.mock.calls.map(([sql]) => sql.join("?")).filter(sql => sql.includes('FROM "Project"') || sql.includes('FROM "Task"'));
    expect(writeLocks.some(sql => sql.includes('FROM "Project"') && sql.includes("FOR UPDATE"))).toBe(true);
    expect(writeLocks.some(sql => sql.includes('FROM "Task"') && sql.includes("FOR UPDATE"))).toBe(true);
  });
  it.each(["edit_description", "reopen"] as const)("denies %s on a soft-deleted marker even for its ADMIN author before receipts", async action => {
    const f = fixture("CLOSED"); f.markers.get(taskId)!.authorId = "admin"; f.markers.get(taskId)!.deletedAt = new Date();
    await expect(f.service.transition(f.input({ actorId: "admin", action, ...(action === "reopen" ? { reason: "reason" } : { description: "denied" }) }))).rejects.toBeInstanceOf(NotFoundError);
    expect(f.writes).toEqual([]); expect(f.tx.taskCommandOperation.findUnique).not.toHaveBeenCalled();
  });

  it("hides internal attachment names and identifiers from an ordinary lifecycle reader", async () => {
    const f = fixture("IN_PROGRESS");
    f.options.attachmentInternal = true;
    expect((await snapshotOf(f, "author")).attachments).toEqual([]);
    expect((await snapshotOf(f, "admin")).attachments).toHaveLength(1);
    expect(f.writes).toEqual([]);
  });

  it("projects state, roles and one-executor candidates for the author", async () => {
    const f = fixture("NEEDS_INFO");
    const snapshot = await snapshotOf(f, "author");
    expect(snapshot).toMatchObject({
      taskId,
      projectId,
      version: 3,
      marked: true,
      deleted: false,
      state: "NEEDS_INFO",
      authorId: "author",
      executorId: "executor",
      executorName: "Executor",
    });
    expect(snapshot.permissions).toMatchObject({
      isAuthor: true,
      isExecutor: false,
      isLeader: false,
      canParticipate: true,
      canAssign: false,
    });
    expect(snapshot.assignees).toBeNull();
    expect(snapshot.attachments).toEqual([
      { id: "0a6e3b9e-3dcb-402e-891a-d1074b75d40f", name: "answer.pdf", size: 4, mime: "application/pdf" },
    ]);
    expect(f.writes).toEqual([]);
  });

  it("offers eligible candidates only to a leader or the executor", async () => {
    const leader = await snapshotOf(fixture("SUBMITTED"), "leader");
    expect(leader.permissions).toMatchObject({ isLeader: true, canAssign: true });
    expect(leader.assignees?.map((candidate) => candidate.id).sort()).toEqual(["executor", "leader"]);

    const executor = await snapshotOf(fixture("IN_PROGRESS"), "executor");
    expect(executor.permissions).toMatchObject({ isExecutor: true, canAssign: true });
    expect(executor.assignees).not.toBeNull();
  });

  it("keeps a draft private to its author while a global administrator still reads it", async () => {
    const outsider = fixture("DRAFT");
    await expect(snapshotOf(outsider, "member")).rejects.toBeInstanceOf(NotFoundError);

    const admin = fixture("DRAFT");
    expect((await snapshotOf(admin, "admin")).state).toBe("DRAFT");
  });

  it("treats an unmarked legacy card as a not-yet-submitted request", async () => {
    const legacy = fixture("DRAFT");
    legacy.setMarker(null);
    expect(await snapshotOf(legacy, "author")).toMatchObject({
      marked: false,
      state: null,
      authorId: "author",
      deleted: false,
    });
    // The legacy card stays readable for board participants; only its author
    // may submit it into the lifecycle.
    const participant = await snapshotOf(legacy, "member");
    expect(participant.permissions).toMatchObject({ isAuthor: false });
    expect(participant.state).toBeNull();
    await expect(snapshotOf(fixture("DRAFT"), "stranger")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("content writer guard for marked requests", () => {
  async function authorize(
    f: Fixture,
    actorId: string,
    kind: "comment" | "attachment" = "comment",
  ) {
    return f.transaction(async (tx) => authorizeTaskRequestContentWrite({
      tx: tx as unknown as Prisma.TransactionClient,
      actorId,
      taskId,
      expectedProjectId: projectId,
      kind,
    }));
  }

  it.each(["comment", "attachment"] as const)("admits a real common task reader without project membership for %s", async kind => {
    for (const actorId of ["outsider", "author"]) {
      const f = fixture("SUBMITTED");
      f.options.watcher = actorId === "outsider";
      vi.mocked(getProjectAccess).mockResolvedValueOnce({ projectId, canRead: false, canWrite: false, canManageMembers: false });
      expect(await authorize(f, actorId, kind)).toMatchObject({ allowed: true, marked: true });
      expect(f.writes).toEqual([]);
    }
  });

  it("rejects board membership alone when common task read is denied", async () => {
    const f = fixture("SUBMITTED"); f.options.taskReader = false;
    await expect(authorize(f, "member")).rejects.toBeInstanceOf(NotFoundError);
    expect(f.writes).toEqual([]);
  });
  it("denies deleted markers and blocked actors without content or lifecycle writes", async () => {
    const deleted = fixture("CLOSED"); deleted.markers.get(taskId)!.deletedAt = new Date();
    await expect(authorize(deleted, "author")).rejects.toBeInstanceOf(NotFoundError);
    const blocked = fixture("SUBMITTED"); blocked.options.blockedIds = ["author"];
    await expect(authorize(blocked, "author", "attachment")).rejects.toBeInstanceOf(NotFoundError);
    expect(deleted.writes).toEqual([]); expect(blocked.writes).toEqual([]);
  });

  it.each(["comment", "attachment"] as const)("denies legacy %s after watcher revocation despite department board discovery", async kind => {
    const f = fixture("DRAFT"); f.setMarker(null); f.options.watcher = false; f.options.taskReader = false;
    vi.mocked(getProjectAccess).mockResolvedValueOnce({ projectId, canRead: true, canWrite: false, canManageMembers: false });
    await expect(authorize(f, "outsider", kind)).rejects.toBeInstanceOf(NotFoundError);
    expect(f.tx.task.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ AND: expect.arrayContaining([{ AND: [{ id: taskId, projectId }, { projectId }] }]) }),
      select: { id: true },
    }));
    expect(f.writes).toEqual([]);
  });

  it("leaves a legacy task on the caller's own path", async () => {
    const f = fixture("DRAFT");
    f.setMarker(null);
    expect(await authorize(f, "member")).toEqual({ allowed: true, marked: false });
    expect(f.writes).toEqual([]);
  });

  it("allows participants, the responsible group and leadership without a lifecycle mutation", async () => {
    const author = fixture("NEEDS_INFO");
    expect(await authorize(author, "author")).toEqual({
      allowed: true, marked: true, state: "NEEDS_INFO",
    });
    const executor = fixture("IN_PROGRESS");
    expect(await authorize(executor, "executor", "attachment"))
      .toEqual({ allowed: true, marked: true, state: "IN_PROGRESS" });
    const watcher = fixture("SUBMITTED");
    watcher.options.watcher = true;
    expect(await authorize(watcher, "member")).toEqual({
      allowed: true, marked: true, state: "SUBMITTED",
    });
    const groupMember = fixture("SUBMITTED");
    groupMember.options.groupMembers = ["member"];
    expect(await authorize(groupMember, "member")).toEqual({
      allowed: true, marked: true, state: "SUBMITTED",
    });
    // A watcher outside the board participates in this request only.
    const outsiderWatcher = fixture("SUBMITTED");
    outsiderWatcher.options.watcher = true;
    vi.mocked(getProjectAccess).mockResolvedValueOnce({
      projectId, canRead: true, canWrite: false, canManageMembers: false,
    });
    expect(await authorize(outsiderWatcher, "outsider")).toEqual({
      allowed: true, marked: true, state: "SUBMITTED",
    });
    const leader = fixture("IN_PROGRESS");
    expect(await authorize(leader, "leader")).toEqual({
      allowed: true, marked: true, state: "IN_PROGRESS",
    });
    for (const f of [author, executor, watcher, groupMember, outsiderWatcher, leader]) {
      expect(f.writes).toEqual([]);
      expect(f.markers.get(taskId)?.state).not.toBe("CANCELLED");
    }
  });

  it("keeps a draft private and admits ordinary discussion through the common reader", async () => {
    const draft = fixture("DRAFT");
    draft.options.groupMembers = ["member"];
    expect(await authorize(draft, "member")).toEqual({
      allowed: false, code: "FORBIDDEN_ROLE",
    });
    expect(await authorize(draft, "executor")).toEqual({
      allowed: false, code: "FORBIDDEN_ROLE",
    });

    const submitted = fixture("SUBMITTED");
    expect(await authorize(submitted, "member")).toEqual({
      allowed: true, marked: true, state: "SUBMITTED",
    });

    // Archival removes the group role but preserves independent reader rights.
    const archived = fixture("SUBMITTED");
    archived.options.groupMembers = ["member"];
    archived.options.groupArchived = true;
    expect(await authorize(archived, "member")).toEqual({
      allowed: true, marked: true, state: "SUBMITTED",
    });
    for (const f of [draft, submitted, archived]) expect(f.writes).toEqual([]);
  });

  it.each(["comment", "attachment"] as const)("does not bypass a common reader denial with a watcher row for %s", async kind => {
    const f = fixture("SUBMITTED");
    f.options.watcher = true;
    f.options.taskReader = false;
    await expect(authorize(f, "outsider", kind)).rejects.toBeInstanceOf(NotFoundError);
    expect(f.tx.$queryRaw.mock.calls.some(([parts]) => parts.join("").includes('FROM "TaskWatcher"') && parts.join("").includes('FOR SHARE'))).toBe(true);
    expect(f.writes).toEqual([]);
  });

  it.each(["comment", "attachment"] as const)("allows a read-only observer on legacy and submitted requests for %s", async kind => {
    for (const marked of [true, false]) {
      const f = fixture("SUBMITTED");
      if (!marked) f.setMarker(null);
      vi.mocked(getProjectAccess).mockResolvedValueOnce({
        projectId, canRead: true, canWrite: false, canManageMembers: false,
      });
      expect(await authorize(f, "outsider", kind)).toMatchObject({ allowed: true, marked });
      expect(f.writes).toEqual([]);
    }
  });

  it("rejects a foreign project for a comment or a file before any write", async () => {
    const f = fixture("SUBMITTED");
    for (const kind of ["comment", "attachment"] as const) {
      await expect(f.transaction(async (tx) => authorizeTaskRequestContentWrite({
        tx: tx as unknown as Prisma.TransactionClient,
        actorId: "author",
        taskId,
        expectedProjectId: "foreign-project",
        kind,
      }))).rejects.toMatchObject({ name: "TaskLifecycleError", code: "IDENTITY_CHANGED" });
    }
    expect(f.writes).toEqual([]);
  });

  it("denies new content on a cancelled request and on a malformed marker", async () => {
    const cancelled = fixture("CANCELLED");
    cancelled.options.watcher = true;
    expect(await authorize(cancelled, "author")).toEqual({
      allowed: false, code: "INVALID_TRANSITION",
    });

    const malformed = fixture("DRAFT");
    malformed.options.markerMalformed = true;
    expect(await authorize(malformed, "author")).toEqual({
      allowed: false, code: "INVALID_REQUEST_MARKER",
    });
    expect(malformed.writes).toEqual([]);
  });
});

describe("lifecycle-aware DELETE boundary", () => {
  async function runDelete(f: Fixture, actorId = "author") {
    return f.transaction(async (tx) => deleteTaskLifecycleAware({
      tx: tx as unknown as Prisma.TransactionClient,
      actorId,
      taskId,
      expectedProjectId: projectId,
    }));
  }

  it("keeps physical legacy deletion for tasks without a marker", async () => {
    const f = fixture("DRAFT");
    f.setMarker(null);
    const result = await f.transaction(async (tx) => deleteTaskLifecycleAware({
      tx: tx as unknown as Prisma.TransactionClient,
      actorId: "author",
      taskId,
      expectedProjectId: projectId,
    }));
    expect(result).toEqual({ logical: false, changed: false, state: null });
    expect(f.writes).toEqual([]);
  });

  it("logically deletes a draft only for its author with audit and version CAS", async () => {
    const f = fixture("DRAFT");
    const result = await runDelete(f);
    expect(result).toEqual({ logical: true, changed: true, state: "CANCELLED" });
    expect(f.markers.get(taskId)).toMatchObject({ state: "CANCELLED", executorId: null });
    expect(f.task.version).toBe(4);
    expect(f.activities).toEqual([expect.objectContaining({ action: "request_deleted" })]);
    expect(f.tx.taskRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        deletedAt: expect.any(Date),
        deletedById: "author",
      }),
    }));
  });

  it("rejects a non-author deleting a draft before work", async () => {
    const f = fixture("DRAFT");
    await expectCode(runDelete(f, "executor"), "FORBIDDEN_ROLE");
    expect(f.writes).toEqual([]);
  });

  it("lets the executor logically delete an in-progress request and keeps it idempotent", async () => {
    const f = fixture("IN_PROGRESS");
    expect(await runDelete(f, "executor")).toEqual({ logical: true, changed: true, state: "CANCELLED" });
    expect(f.markers.get(taskId)).toMatchObject({ state: "CANCELLED", executorId: "executor" });
    const repeated = await runDelete(f, "executor");
    expect(repeated).toEqual({ logical: true, changed: false, state: "CANCELLED" });
    expect(f.activities).toHaveLength(1);
  });

  it("fails closed on a malformed stored marker", async () => {
    const f = fixture("DRAFT");
    f.options.markerMalformed = true;
    await expectCode(runDelete(f), "INVALID_REQUEST_MARKER");
    expect(f.writes).toEqual([]);
  });
});


describe("fresh destination department execution authority", () => {
  it("lets current department staff take without a group or project membership", async () => {
    const f = fixture("SUBMITTED"); f.options.groupMembers = []; f.options.departmentStaff = ["outsider"];
    expect((await f.service.snapshot({ actorId: "outsider", taskId })).permissions).toMatchObject({ isGroupMember: false, canExecute: true });
    expect((await f.service.transition(f.input({ actorId: "outsider", action: "take" }))).ack).toMatchObject({ state: "IN_PROGRESS", executorId: "outsider" });
    const sql = f.tx.$queryRaw.mock.calls.map(call => call[0].join("?"));
    expect(sql).toContainEqual(expect.stringMatching(/FROM "Department".*FOR SHARE/));
    expect(sql).toContainEqual(expect.stringMatching(/FROM "User".*FOR SHARE/));
    expect(f.tx.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ select: expect.objectContaining({ primaryDepartmentId: true, isBlocked: true, blockedAt: true }) }));
  });
  it("does not let a foreign department group member or watcher execute", async () => {
    const f = fixture("SUBMITTED"); f.options.groupMembers = ["member"]; f.options.departmentStaff = ["executor"]; f.options.watcher = true;
    expect((await f.service.snapshot({ actorId: "member", taskId })).permissions.canExecute).toBe(false);
    await expectCode(f.service.transition(f.input({ actorId: "member", action: "take" })), "FORBIDDEN_ROLE");
    expect(f.writes).toEqual([]);
  });
  it("keeps leadership read separate from staff execution", async () => {
    const f = fixture("SUBMITTED"); f.options.departmentStaff = ["executor"]; f.options.groupMembers = ["leader"];
    expect((await f.service.snapshot({ actorId: "leader", taskId })).permissions).toMatchObject({ isLeader: true, canExecute: false, canAssign: false });
    await expectCode(f.service.transition(f.input({ actorId: "leader", action: "take" })), "FORBIDDEN_ROLE");
    expect(f.writes).toEqual([]);
  });
  it("filters assignment candidates by staff activity and the personal audience", async () => {
    const f = fixture("IN_PROGRESS"); f.options.departmentStaff = ["executor", "member", "outsider"]; f.options.audienceUserIds = ["executor", "member"]; f.options.blockedAtOnlyIds = ["member"];
    expect((await f.service.snapshot({ actorId: "executor", taskId })).assignees?.map(user => user.id)).toEqual(["executor"]);
    expect(f.tx.user.findMany).toHaveBeenCalledWith({ where: { primaryDepartmentId: "department", isBlocked: false, blockedAt: null }, select: { id: true, name: true, email: true } });
  });
  it("rechecks an assignment target whose primary department changed despite group membership", async () => {
    const f = fixture("IN_PROGRESS"); f.options.departmentStaff = ["executor"]; f.options.groupMembers = ["executor", "member"];
    await expectCode(f.service.transition(f.input({ actorId: "executor", action: "assign", assigneeId: "member" })), "ASSIGNEE_NOT_ELIGIBLE");
    expect(f.writes).toEqual([]);
  });
  it("returns reopened work to the queue when the former executor moved departments", async () => {
    const f = fixture("COMPLETED"); f.options.departmentStaff = ["member"]; f.options.groupMembers = ["executor"];
    expect((await f.service.transition(f.input({ action: "reopen", reason: "Still unresolved" }))).ack).toMatchObject({ state: "SUBMITTED", executorId: null });
  });
  it("revokes new execution after leaving the department and keeps exact receipt reads free of writes", async () => {
    const f = fixture("SUBMITTED"); f.options.departmentStaff = ["executor"]; const command = f.input({ actorId: "executor", action: "take" });
    await f.service.transition(command); const writes = [...f.writes]; f.options.departmentStaff = [];
    expect((await f.service.transition(command)).ack.replayed).toBe(true);
    expect((await f.service.snapshot({ actorId: "executor", taskId })).permissions.canExecute).toBe(false);
    await expectCode(f.service.transition(f.input({ actorId: "executor", action: "complete" })), "FORBIDDEN_ROLE"); expect(f.writes).toEqual(writes);
  });
  it("denies archived destination staff without using an active group's fallback", async () => {
    const f = fixture("SUBMITTED"); f.options.departmentStaff = ["executor"]; f.options.departmentArchived = true;
    await expectCode(f.service.transition(f.input({ actorId: "executor", action: "take" })), "FORBIDDEN_ROLE"); expect(f.writes).toEqual([]);
  });
  it("retains group-only execution on boards without a department", async () => {
    const f = fixture("SUBMITTED"); f.options.departmentBound = false; f.options.departmentStaff = []; f.options.groupMembers = ["outsider"];
    expect((await f.service.transition(f.input({ actorId: "outsider", action: "take" }))).ack.executorId).toBe("outsider");
    const archived = fixture("SUBMITTED"); archived.options.departmentBound = false; archived.options.groupArchived = true;
    await expectCode(archived.service.transition(archived.input({ actorId: "executor", action: "take" })), "FORBIDDEN_ROLE"); expect(archived.writes).toEqual([]);
  });
});


describe("durable post-submission description edit metadata", () => {
  it.each(["SUBMITTED", "IN_PROGRESS", "NEEDS_INFO"] as const)("records the author's real edit in %s without changing its state", async state => {
    const f = fixture(state);
    const result = await f.service.transition(f.input({ action: "edit_description", description: "Corrected sent text" }));
    expect(result.ack.state).toBe(state);
    expect(f.activities).toEqual([expect.objectContaining({ action: "description_changed", userId: "author", newValue: { description: "Corrected sent text", afterSubmission: true } })]);
  });
  it("continues to allow an author correction after answering a colleague", async () => {
    const f = fixture("NEEDS_INFO");
    await f.service.transition(f.input({ action: "answer_info", response: { commentId: "comment" } }));
    await f.service.transition(f.input({ action: "edit_description", description: "Further correction after the answer" }));
    expect(f.markers.get(taskId)?.state).toBe("IN_PROGRESS");
    expect(f.activities.filter(row => row.action === "description_changed")).toEqual([expect.objectContaining({ newValue: { description: "Further correction after the answer", afterSubmission: true } })]);
  });
  it("marks draft edits as before submission and does not duplicate events on exact retry or a no-op", async () => {
    const f = fixture("DRAFT"); const command = f.input({ action: "edit_description", description: "Draft correction" });
    await f.service.transition(command); await f.service.transition(command);
    await f.service.transition(f.input({ action: "edit_description", description: "Draft correction" }));
    expect(f.activities).toEqual([expect.objectContaining({ newValue: { description: "Draft correction", afterSubmission: false } })]);
  });
  it("does not record an edit marker when the concurrency guard rejects the write", async () => {
    const f = fixture("IN_PROGRESS");
    await expectCode(f.service.transition(f.input({ action: "edit_description", description: "Rejected correction", expectedVersion: 0 })), "STALE_TASK_VERSION");
    expect(f.activities).toEqual([]); expect(f.writes).toEqual([]);
  });
});


describe("original attachment removal shares the description authority", () => {
  it.each(["DRAFT", "SUBMITTED", "IN_PROGRESS", "NEEDS_INFO"] as const)("admits the fresh author in %s without writing a description", async state => {
    const f = fixture(state); await expect(authorizeTaskAttachmentDetach({ tx: f.tx as never, actorId: "author", taskId, expectedProjectId: projectId })).resolves.toMatchObject({ version: 3 }); expect(f.writes).toEqual([]);
  });
  it.each(["COMPLETED", "CLOSED", "CANCELLED"] as const)("does not expand original-description rights in %s", async state => {
    const f = fixture(state); await expect(authorizeTaskAttachmentDetach({ tx: f.tx as never, actorId: "author", taskId, expectedProjectId: projectId })).rejects.toMatchObject({ code: "INVALID_TRANSITION" }); expect(f.writes).toEqual([]);
  });
  it("does not turn a reader/watcher into an original attachment editor", async () => {
    const f = fixture("SUBMITTED"); f.options.watcher = true;
    await expect(authorizeTaskAttachmentDetach({ tx: f.tx as never, actorId: "member", taskId, expectedProjectId: projectId })).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" }); expect(f.writes).toEqual([]);
  });
  it("rechecks current task visibility even for a previously authorized author", async () => {
    const f = fixture("SUBMITTED"); f.options.taskReader = false;
    await expect(authorizeTaskAttachmentDetach({ tx: f.tx as never, actorId: "author", taskId, expectedProjectId: projectId })).rejects.toBeInstanceOf(NotFoundError); expect(f.writes).toEqual([]);
  });
});

it("does not accept a soft-deleted own message as a clarification answer", async () => {
  const f = fixture("NEEDS_INFO");
  f.tx.chatMessage.findUnique.mockResolvedValueOnce({ taskId, authorId: "author", deletedAt: new Date() } as never);
  await expectCode(f.service.transition(f.input({ action: "answer_info", response: { commentId: "comment" } })), "INVALID_COMMAND");
  expect(f.writes).toEqual([]); expect(f.markers.get(taskId)?.state).toBe("NEEDS_INFO");
});


describe("explicit execution and management permissions", () => {
  it("denies department staff without execution role and preserves the request", async () => {
    const f = fixture("SUBMITTED"); f.options.executionDeniedIds.push("executor");
    await expect(f.service.transition(f.input({ actorId: "executor", action: "take" }))).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
    expect(f.writes).toEqual([]); expect(f.markers.get(taskId)?.executorId).toBeNull();
  });
  it("rechecks execution permission for an existing executor's completion", async () => {
    const f = fixture("IN_PROGRESS"); f.options.executionDeniedIds.push("executor");
    await expect(f.service.transition(f.input({ actorId: "executor", action: "complete" }))).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
    expect(f.writes).toEqual([]);
  });
  it("rejects assignment to a department member without execution role", async () => {
    const f = fixture("IN_PROGRESS"); f.options.groupMembers.push("member"); f.options.executionDeniedIds.push("member");
    await expect(f.service.transition(f.input({ actorId: "executor", action: "assign", assigneeId: "member" }))).rejects.toMatchObject({ code: "ASSIGNEE_NOT_ELIGIBLE" });
    expect(f.writes).toEqual([]);
  });
  it("scoped management grants existing leader operations without changing global role", async () => {
    const f = fixture("IN_PROGRESS"); f.options.groupMembers.push("member"); f.options.manageRoleIds.push("member");
    await expect(f.service.transition(f.input({ actorId: "member", action: "request_info", reason: "Need details" }))).resolves.toMatchObject({ ack: { state: "NEEDS_INFO" } });
  });
  it("a matching role cannot replace department staffing", async () => {
    const f = fixture("SUBMITTED"); f.options.departmentStaff = ["executor"];
    await expect(f.service.transition(f.input({ actorId: "member", action: "take" }))).rejects.toMatchObject({ code: "FORBIDDEN_ROLE" });
    expect(f.writes).toEqual([]);
  });
});

describe("BezNal content and persistent revision phase on the common service",()=>{
 const effect=(f:Fixture,kind:"comment"|"invoice",actorId="executor",isPublic=true)=>commitBeznalContentEffect({tx:f.tx as unknown as Prisma.TransactionClient,actorId,taskId,projectId,kind,public:isPublic,invoiceUrl:kind==="invoice"?"/api/tasks/task/files/0a6e3b9e-3dcb-402e-891a-d1074b75d40f":undefined});
 it("claims free request on successful public accounting comment without marking invoice ready",async()=>{
  const f=fixture("SUBMITTED");f.options.beznal=true;
  expect(await effect(f,"comment")).toMatchObject({claimed:true,phaseChanged:false});
  expect(f.markers.get(taskId)).toMatchObject({state:"IN_PROGRESS",executorId:"executor"});expect(f.options.beznalPhase).toBe("WAITING");expect(f.task.version).toBe(4);
  expect(f.activities).toEqual([expect.objectContaining({action:"request_taken"})]);
 });
 it("claims and sets INVOICED/reference atomically on a public accounting file",async()=>{
  const f=fixture("SUBMITTED");f.options.beznal=true;
  expect(await effect(f,"invoice")).toMatchObject({claimed:true,phaseChanged:true});expect(f.options.beznalPhase).toBe("INVOICED");expect(f.options.currentInvoiceUrl).toBe("/api/tasks/task/files/0a6e3b9e-3dcb-402e-891a-d1074b75d40f");expect(f.markers.get(taskId)?.executorId).toBe("executor");
 });
 it("accepts corrected invoice after return without a second version write or empty Prisma update",async()=>{
  const f=fixture("IN_PROGRESS");f.options.beznal=true;f.options.beznalPhase="WAITING";
  const alreadyIncrementedVersion=f.task.version;
  f.tx.task.updateMany.mockImplementationOnce(async()=>({count:0}));
  const result=await commitBeznalContentEffect({tx:f.tx as unknown as Prisma.TransactionClient,actorId:"executor",taskId,projectId,kind:"invoice",public:true,invoiceUrl:"/api/tasks/task/files/0a6e3b9e-3dcb-402e-891a-d1074b75d40f",versionAlreadyIncremented:true});
  expect(result).toEqual({claimed:false,phaseChanged:true});
  expect(f.options.beznalPhase).toBe("INVOICED");
  expect(f.task.version).toBe(alreadyIncrementedVersion);
  expect(f.tx.task.updateMany).not.toHaveBeenCalled();
  expect(f.markers.get(taskId)?.executorId).toBe("executor");
 });
 it("never claims for Sales/internal content and never replaces another executor",async()=>{
  const f=fixture("SUBMITTED");f.options.beznal=true;f.options.executionDeniedIds=["author"];
  expect(await effect(f,"invoice","author")).toEqual({claimed:false,phaseChanged:false});expect(await effect(f,"comment","executor",false)).toEqual({claimed:false,phaseChanged:false});expect(f.markers.get(taskId)?.executorId).toBeNull();
  f.markers.get(taskId)!.state="IN_PROGRESS";f.markers.get(taskId)!.executorId="member";
  expect(await effect(f,"invoice")).toEqual({claimed:false,phaseChanged:false});expect(f.markers.get(taskId)?.executorId).toBe("member");expect(f.options.beznalPhase).toBe("WAITING");
 });
 it("return records one public reason and one versioned receipt, preserving executor and old files",async()=>{
  const f=fixture("IN_PROGRESS");f.options.beznal=true;f.options.beznalPhase="INVOICED";f.options.returnRoleIds=["member"];f.options.executionDeniedIds=["member"];
  const command=f.input({actorId:"member",action:"return_for_revision",reason:"Исправить сумму"});
  expect((await f.service.transition(command)).ack).toMatchObject({changed:true,state:"IN_PROGRESS",executorId:"executor",version:4});
  expect(f.options.beznalPhase).toBe("WAITING");expect(f.tx.chatMessage.create).toHaveBeenCalledOnce();expect(f.tx.taskAssignee.deleteMany).not.toHaveBeenCalled();expect(f.activities).toEqual([expect.objectContaining({action:"request_returned_for_revision"})]);
  expect((await f.service.transition(command)).ack.replayed).toBe(true);expect(f.tx.chatMessage.create).toHaveBeenCalledOnce();
 });
});

it("never treats a nonexistent or currently internal file as an invoice or first claim",async()=>{
 const f=fixture("SUBMITTED");f.options.beznal=true;f.options.attachmentInternal=true;
 await expect(commitBeznalContentEffect({tx:f.tx as unknown as Prisma.TransactionClient,actorId:"executor",taskId,projectId,kind:"invoice",public:true,invoiceUrl:"/api/tasks/task/files/0a6e3b9e-3dcb-402e-891a-d1074b75d40f"})).rejects.toMatchObject({code:"INVALID_COMMAND"});
 expect(f.markers.get(taskId)?.executorId).toBeNull();expect(f.activities).toEqual([]);
});

it("Sales common-reader can comment on others but upload only to their own request",async()=>{
 const f=fixture("SUBMITTED");f.options.beznal=true;f.options.returnRoleIds=["member","author"];f.options.executionDeniedIds=["member","author"];
 const input=(actorId:string,kind:"comment"|"attachment")=>authorizeTaskRequestContentWrite({tx:f.tx as unknown as Prisma.TransactionClient,actorId,taskId,expectedProjectId:projectId,kind});
 expect(await input("member","comment")).toMatchObject({allowed:true,marked:true});
 expect(await input("member","attachment")).toEqual({allowed:false,code:"FORBIDDEN_ROLE"});
 expect(await input("author","attachment")).toMatchObject({allowed:true,marked:true});
 expect(f.writes).toEqual([]);
});

describe("BezNal customer approval and reusing an existing public invoice",()=>{
 const invoiceUrl="/api/tasks/task/files/0a6e3b9e-3dcb-402e-891a-d1074b75d40f";
 it("marks existing public invoice ready once without reupload and then author approves directly CLOSED",async()=>{
  const f=fixture("IN_PROGRESS");f.options.beznal=true;const ready=f.input({actorId:"executor",action:"mark_invoice_ready",invoiceUrl});
  expect((await f.service.transition(ready)).ack).toMatchObject({state:"IN_PROGRESS",changed:true,version:4});expect(f.options.beznalPhase).toBe("INVOICED");expect(f.options.currentInvoiceUrl).toBe(invoiceUrl);
  expect((await f.service.transition(ready)).ack.replayed).toBe(true);
  expect((await f.service.transition(f.input({actorId:"author",action:"approve",expectedVersion:4}))).ack).toMatchObject({state:"CLOSED",executorId:"executor",version:5});
  expect(f.activities.map(a=>a.action)).toEqual(["request_invoice_marked_ready","request_approved"]);
 });
 it("allows board-scoped Sales approval with task read, never an executor-only close or other finalization bypass",async()=>{
  const f=fixture("IN_PROGRESS");f.options.beznal=true;f.options.beznalPhase="INVOICED";f.options.approveRoleIds=["member"];f.options.executionDeniedIds=["member"];
  for(const action of ["complete","close","cancel","delete","reopen","approve"] as const)await expect(f.service.transition(f.input({actorId:"executor",action,...(action==="reopen"?{reason:"Again"}:{})}))).rejects.toMatchObject({code:"FORBIDDEN_ROLE"});
  expect((await f.service.transition(f.input({actorId:"member",action:"approve"}))).ack.state).toBe("CLOSED");
 });
 it.each(["COMPLETED","CLOSED"] as const)("author returns archived %s retaining accountant and invoice files in WAITING",async state=>{
  const f=fixture(state);f.options.beznal=true;f.options.beznalPhase="INVOICED";f.options.currentInvoiceUrl=invoiceUrl;
  expect((await f.service.transition(f.input({actorId:"author",action:"return_for_revision",reason:"Исправить реквизиты"}))).ack).toMatchObject({state:"IN_PROGRESS",executorId:"executor"});
  expect(f.options.beznalPhase).toBe("WAITING");expect(f.options.currentInvoiceUrl).toBeNull();expect(f.tx.chatMessage.create).toHaveBeenCalledOnce();expect(f.task.columnId).toBe("working-column");expect(f.tx.taskAssignee.deleteMany).not.toHaveBeenCalled();
 });
 it.each(["attachmentInternal","attachmentPending"] as const)("refuses %s even for current executor",async flag=>{
  const f=fixture("IN_PROGRESS");f.options.beznal=true;f.options[flag]=true;
  await expect(f.service.transition(f.input({actorId:"executor",action:"mark_invoice_ready",invoiceUrl}))).rejects.toMatchObject({code:"INVALID_COMMAND"});expect(f.task.version).toBe(3);expect(f.activities).toEqual([]);
 });
 it("requires actual current published URL and keeps selector free from internal/pending references",async()=>{
  const f=fixture("IN_PROGRESS");f.options.beznal=true;
  const snap=await f.service.snapshot({actorId:"executor",taskId});expect(snap.workflowKind).toBe("beznal");expect(snap.permissions.canMarkInvoiceReady).toBe(true);expect(snap.invoiceFiles).toEqual([{url:invoiceUrl,name:"answer.pdf"}]);
  f.options.attachmentPending=true;expect((await f.service.snapshot({actorId:"executor",taskId})).invoiceFiles).toEqual([]);
  await expect(f.service.transition(f.input({actorId:"executor",action:"mark_invoice_ready",invoiceUrl:invoiceUrl.replace("d40f","d40e")}))).rejects.toMatchObject({code:"INVALID_COMMAND"});
 });
});
