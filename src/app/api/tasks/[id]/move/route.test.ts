import { beforeEach, describe, expect, it, vi } from "vitest";
import { MoveTaskError } from "@/features/kanban/server/move-errors";
import type { MoveTaskResponse } from "@/features/kanban/server/move-contract";

const mocks = vi.hoisted(() => ({
  diagnostic: vi.fn(),
  emitTaskMoved: vi.fn(),
  requireApiUser: vi.fn(),
  repositoryTransact: vi.fn(),
  moveTask: vi.fn(),
  prismaTaskFindUnique: vi.fn(),
  prismaUserFindUnique: vi.fn(),
  processMoveAutomation: vi.fn(),
  repositoryConstructor: vi.fn(),
  requireProjectWrite: vi.fn(),
}));

vi.mock("@/lib/require-api-user", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/require-api-user")>(),
  requireApiUser: mocks.requireApiUser,
}));
// Quota SQL is exercised by adjacent route.rate-limit tests; retain this
// fixture's focused transactional/receipt/rollback assertions behind admission.
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: async () => undefined, rateLimitErrorResponse: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findUnique: mocks.prismaTaskFindUnique },
    user: { findUnique: mocks.prismaUserFindUnique },
  },
}));
vi.mock("@/lib/project-access", () => ({
  requireProjectWrite: mocks.requireProjectWrite,
}));
vi.mock("@/features/kanban/server/move-task-service", () => ({
  moveTask: mocks.moveTask,
}));
vi.mock("@/features/kanban/server/prisma-move-repository", () => ({
  PrismaMoveRepository: class {
    transact = mocks.repositoryTransact;
    constructor(...args: unknown[]) {
      mocks.repositoryConstructor(...args);
    }
  },
}));
vi.mock("@/socket/board-events", () => ({
  emitTaskMoved: mocks.emitTaskMoved,
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: mocks.diagnostic } }));
vi.mock("@/lib/automation-processor", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/automation-processor")>(),
  processMoveAutomation: mocks.processMoveAutomation,
}));

import { moveAutomationEvent } from "@/lib/automation-processor";
import { POST } from "./route";
import { UnauthorizedError } from "@/lib/require-api-user";
import type { MoveTaskRepository, MoveTaskTransaction } from "@/features/kanban/server/move-task-service";

const operationId = "b1e62929-6741-4860-a6a3-5f90b82d5a11";
const committedMove: MoveTaskResponse = {
  operationId,
  boardRevision: 8,
  task: {
    id: "task-1",
    columnId: "doing",
    version: 3,
    status: "IN_PROGRESS",
  },
};

function validRequest(bearer = false): Request {
  return new Request("http://localhost/api/tasks/task-1/move", {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: "Bearer synthetic-token" } : {}) },
    body: JSON.stringify({
      toColumnId: "doing",
      beforeTaskId: "task-2",
      afterTaskId: null,
      operationId,
      expectedVersion: 2,
    }),
  });
}

function invoke(request = validRequest()) {
  return POST(request, {
    params: Promise.resolve({ id: "task-1" }),
  });
}

async function expectApiError(
  response: Response,
  expected: {
    status: number;
    code: string;
    message: string;
  },
) {
  expect(response.status).toBe(expected.status);
  await expect(response.json()).resolves.toMatchObject({
    error: {
      code: expected.code,
      message: expected.message,
    },
  });
}

describe("POST /api/tasks/[id]/move", () => {
  beforeEach(() => {
    mocks.emitTaskMoved.mockReset().mockResolvedValue(undefined);
    mocks.requireApiUser.mockReset().mockResolvedValue({ id: "user-1", globalRole: "USER" });
    mocks.repositoryTransact.mockReset();
    mocks.moveTask.mockReset().mockResolvedValue(committedMove);
    mocks.prismaTaskFindUnique.mockReset().mockResolvedValue({
      projectId: "project-1",
      status: "TODO",
      version: 2,
    });
    mocks.processMoveAutomation.mockReset().mockResolvedValue(undefined);
    mocks.diagnostic.mockReset();
    mocks.prismaUserFindUnique.mockReset().mockResolvedValue({
      id: "user-1",
      globalRole: "USER",
    });
    mocks.repositoryConstructor.mockReset();
    mocks.requireProjectWrite.mockReset().mockResolvedValue(undefined);
  });

  it.each([undefined, "Bearer synthetic-token"])("forwards the request and resolved actor through the common guard (%s)", async authorization => {
    const request = validRequest();
    if (authorization) request.headers.set("authorization", authorization);
    mocks.requireApiUser.mockResolvedValueOnce({ id: "token-owner", globalRole: "USER" });
    expect((await invoke(request)).status).toBe(200);
    expect(mocks.requireApiUser).toHaveBeenCalledWith(request);
    expect(mocks.requireProjectWrite).toHaveBeenCalledWith({ id: "token-owner", globalRole: "USER" }, "project-1");
    expect(mocks.repositoryConstructor).toHaveBeenCalledWith(expect.anything(), {
      taskId: "task-1", toColumnId: "doing", operationId, actorId: "token-owner",
    });
    expect(mocks.processMoveAutomation).toHaveBeenCalledWith(expect.objectContaining({ userId: "token-owner" }));
  });

  it("binds durable receipts to the actor and unwraps only that actor's replay", async () => {
    const storeOperation = vi.fn();
    let stored: { operationId: string; requestHash: string; response: MoveTaskResponse } | null = null;
    const tx = {
      getOperation: vi.fn(async () => stored),
      storeOperation: storeOperation.mockImplementation(async receipt => { stored = receipt; }),
    } as unknown as MoveTaskTransaction;
    mocks.repositoryTransact.mockImplementation(operation => operation(tx));
    mocks.moveTask.mockImplementation(async ({ repository }: { repository: MoveTaskRepository }) => repository.transact(async port => {
      const existing = await port.getOperation(operationId);
      if (existing) {
        expect(existing.requestHash).toBe("service-payload-hash");
        return existing.response;
      }
      await port.storeOperation({ operationId, taskId: "task-1", projectId: "project-1", requestHash: "service-payload-hash", response: committedMove });
      return committedMove;
    }));

    const first = await invoke(validRequest(true));
    const replay = await invoke(validRequest(true));
    expect(first.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
    expect(storeOperation).toHaveBeenCalledOnce();
    expect(storeOperation.mock.calls[0][0].requestHash).toMatch(/^[a-f0-9]{64}:service-payload-hash$/);
    expect(storeOperation.mock.calls[0][0].requestHash).not.toContain("user-1");

    mocks.requireApiUser.mockResolvedValueOnce({ id: "another-owner", globalRole: "USER" });
    const conflict = await invoke(validRequest(true));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: "OPERATION_ID_REUSED" } });
    expect(storeOperation).toHaveBeenCalledOnce();
  });

  it("preserves existing unbound receipts for session retries", async () => {
    const receipt = { operationId, requestHash: "legacy-service-hash", response: committedMove };
    const getOperation = vi.fn().mockResolvedValue(receipt);
    const storeOperation = vi.fn();
    const tx = { getOperation, storeOperation } as unknown as MoveTaskTransaction;
    mocks.repositoryTransact.mockImplementation(operation => operation(tx));
    mocks.moveTask.mockImplementation(async ({ repository }: { repository: MoveTaskRepository }) => repository.transact(async port => {
      expect(await port.getOperation(operationId)).toEqual(receipt);
      await port.storeOperation({ ...receipt, taskId: "task-1", projectId: "project-1" });
      return receipt.response;
    }));
    const response = await invoke();
    expect(response.status).toBe(200);
    expect(storeOperation).toHaveBeenCalledWith({ ...receipt, taskId: "task-1", projectId: "project-1" });
  });

  it("refuses bearer replay of an existing receipt without verified ownership", async () => {
    const storeOperation = vi.fn();
    const tx = {
      getOperation: vi.fn().mockResolvedValue({ operationId, requestHash: "legacy-service-hash", response: committedMove }),
      storeOperation,
    } as unknown as MoveTaskTransaction;
    mocks.repositoryTransact.mockImplementation(operation => operation(tx));
    mocks.moveTask.mockImplementation(async ({ repository }: { repository: MoveTaskRepository }) => repository.transact(async port => {
      await port.getOperation(operationId);
      return committedMove;
    }));
    const response = await invoke(validRequest(true));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "OPERATION_ID_REUSED" } });
    expect(storeOperation).not.toHaveBeenCalled();
  });

  it.each([
    {
      code: "TASK_NOT_FOUND" as const,
      status: 404,
      message: "Задача не найдена",
    },
    {
      code: "STALE_TASK_VERSION" as const,
      status: 409,
      message:
        "Задача была изменена. Обновите доску и повторите попытку",
    },
    {
      code: "OPERATION_ID_REUSED" as const,
      status: 409,
      message:
        "Идентификатор операции уже использован для другого перемещения",
    },
    {
      code: "INVALID_DESTINATION_COLUMN" as const,
      status: 422,
      message: "Колонка назначения не найдена в этом проекте",
    },
    {
      code: "INVALID_MOVE_NEIGHBORS" as const,
      status: 422,
      message:
        "Не удалось определить точное место в колонке. Обновите доску. Если ошибка повторяется, обратитесь к ответственному за доску",
    },
  ])(
    "maps $code to stable status and Russian copy",
    async ({ code, status, message }) => {
      mocks.moveTask.mockRejectedValueOnce(new MoveTaskError(code));

      const response = await invoke();

      await expectApiError(response, { status, code, message });
      expect(mocks.emitTaskMoved).not.toHaveBeenCalled();
      expect(mocks.processMoveAutomation).not.toHaveBeenCalled();
    },
  );

  it("does not expose raw hidden-anchor fields in invalid-neighbor responses", async () => {
    const failure = Object.assign(new MoveTaskError("INVALID_MOVE_NEIGHBORS"), {
      message: "hidden-task-private-title", beforeTaskId: "hidden-anchor-private-id", count: 12,
    });
    mocks.moveTask.mockRejectedValueOnce(failure);
    const response = await invoke();
    expect(response.status).toBe(422);
    const body = await response.text();
    expect(body).toContain("INVALID_MOVE_NEIGHBORS");
    expect(body).toContain("обратитесь к ответственному за доску");
    expect(body).not.toMatch(/hidden-task|hidden-anchor|beforeTaskId|"count"/);
    expect(mocks.emitTaskMoved).not.toHaveBeenCalled();
  });
  it("returns Russian copy when the task lookup misses", async () => {
    mocks.prismaTaskFindUnique.mockResolvedValueOnce(null);

    await expectApiError(await invoke(), {
      status: 404,
      code: "TASK_NOT_FOUND",
      message: "Задача не найдена",
    });
  });
  it.each(["REQUEST_LIFECYCLE_NOT_ENABLED", "INVALID_REQUEST_MARKER"] as const)("maps %s to safe409 without realtime effects", async code => {
    mocks.moveTask.mockRejectedValueOnce(new MoveTaskError(code)); const response = await invoke();
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code } }); expect(mocks.emitTaskMoved).not.toHaveBeenCalled();
  });

  it("returns Russian copy for invalid JSON", async () => {
    const request = new Request(
      "http://localhost/api/tasks/task-1/move",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      },
    );

    await expectApiError(await invoke(request), {
      status: 400,
      code: "INVALID_JSON",
      message: "Некорректный JSON в запросе",
    });
  });

  it("returns Russian copy for strict request validation failures", async () => {
    const request = new Request(
      "http://localhost/api/tasks/task-1/move",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toColumnId: "doing" }),
      },
    );

    await expectApiError(await invoke(request), {
      status: 422,
      code: "VALIDATION_ERROR",
      message: "Некорректные параметры перемещения",
    });
  });

  it("returns Russian copy for an internal movement failure", async () => {
    mocks.moveTask.mockRejectedValueOnce(new Error("database failed"));

    await expectApiError(await invoke(), {
      status: 500,
      code: "INTERNAL_ERROR",
      message: "Не удалось переместить задачу",
    });
  });

  it("returns Russian copy when authentication is required", async () => {
    mocks.requireApiUser.mockRejectedValueOnce(new UnauthorizedError());

    await expectApiError(await invoke(), {
      status: 401,
      code: "UNAUTHORIZED",
      message: "Требуется авторизация",
    });
  });

  it("emits the committed response only after moveTask resolves", async () => {
    let resolveMove: ((value: MoveTaskResponse) => void) | undefined;
    mocks.moveTask.mockReturnValueOnce(
      new Promise<MoveTaskResponse>((resolve) => {
        resolveMove = resolve;
      }),
    );

    const responsePromise = invoke();
    await vi.waitFor(() => expect(mocks.moveTask).toHaveBeenCalledOnce());
    expect(mocks.emitTaskMoved).not.toHaveBeenCalled();

    resolveMove?.(committedMove);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(mocks.emitTaskMoved).toHaveBeenCalledWith(
      "project-1",
      committedMove,
    );
  });

  it("starts status_changed automation once after the committed workflow move", async () => {
    const response = await invoke();

    expect(response.status).toBe(200);
    expect(mocks.processMoveAutomation).toHaveBeenCalledOnce();
    expect(mocks.processMoveAutomation).toHaveBeenCalledWith({
      taskId: "task-1",
      projectId: "project-1",
      userId: "user-1",
      previousStatus: "TODO",
      result: committedMove,
      replayed: false,
    });
  });

  it("passes the pre-move status so a same-column reorder builds no event", async () => {
    const sameColumnMove: MoveTaskResponse = {
      ...committedMove,
      task: { ...committedMove.task, columnId: "todo", status: "TODO" },
    };
    mocks.moveTask.mockResolvedValueOnce(sameColumnMove);

    await invoke();

    const input = mocks.processMoveAutomation.mock.calls[0][0];
    expect(input.previousStatus).toBe(input.result.task.status);
    expect(moveAutomationEvent(input)).toBeNull();
  });

  it("marks a stored operationId replay so no second status event is built", async () => {
    // The task is already at version 6 while the stored response reports 3.
    mocks.prismaTaskFindUnique.mockResolvedValueOnce({
      projectId: "project-1",
      status: "TODO",
      version: 6,
    });

    await invoke();

    const input = mocks.processMoveAutomation.mock.calls[0][0];
    expect(input.replayed).toBe(true);
    expect(moveAutomationEvent(input)).toBeNull();
  });

  it("still treats a move that advanced the version past the pre-read as committed", async () => {
    // Another writer committed between the identity read and this transaction,
    // so the version moved by two; this is not a replay.
    mocks.moveTask.mockResolvedValueOnce({ ...committedMove, task: { ...committedMove.task, version: 4 } });

    await invoke();

    expect(mocks.processMoveAutomation.mock.calls[0][0]).toMatchObject({ replayed: false, previousStatus: "TODO" });
  });

  it("keeps the committed move response when automation fails", async () => {
    mocks.processMoveAutomation.mockRejectedValueOnce(new Error("synthetic-private-automation"));

    const response = await invoke();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { task: { id: "task-1", status: "IN_PROGRESS" } },
    });
    expect(mocks.diagnostic).toHaveBeenCalledWith({
      event: "task.move.automation.failed",
      route: "/api/tasks/:id/move",
      err: expect.any(Error),
    });
    expect(JSON.stringify(mocks.diagnostic.mock.calls)).not.toMatch(/synthetic-private-automation/);
  });
});
