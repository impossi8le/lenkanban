import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ database: {} as object, auth: vi.fn(), guard: vi.fn(), notify: vi.fn(), persist:vi.fn(), emit: vi.fn() }));
vi.mock("@/socket/board-events", () => ({ emitTaskMessageCreated: mocks.emit }));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(mocks.database, key) }) }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: mocks.auth, UnauthorizedError: class extends Error {} }));
vi.mock("@/lib/project-access", () => ({ getTaskReadWhere: vi.fn(async (_actor, where) => where) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: vi.fn(), rateLimitErrorResponse: vi.fn() }));
vi.mock("@/features/kanban/server/task-lifecycle-service", () => ({
  authorizeTaskRequestContentWrite: mocks.guard, TaskLifecycleError: class extends Error {},
}));
vi.mock("./discussion-notifications", () => ({ persistTaskContentNotifications: mocks.persist }));
vi.mock("@/lib/notifications",async original=>({...await original<typeof import("@/lib/notifications")>(),deliverNotifications:mocks.notify}));
vi.mock("./discussion-access", () => ({
  canActorReadInternal: vi.fn(async () => false), loadProjectDiscussionFacts: vi.fn(async () => ({})),
  loadInternalMessageIds: vi.fn(async () => new Set()), markMessageInternal: vi.fn(),
}));

import { POST } from "./route";
import { NotFoundError } from "@/lib/errors";

const operationId = "854718b1-8b74-4136-8000-000000000001";
const createdAt = new Date("2026-10-22T12:00:00Z");
type Receipt = { operationId: string; taskId: string; projectId: string; requestHash: string; response: unknown };
type State = { version: number; messages: object[]; activities: object[]; receipts: Receipt[] };

function fixture() {
  let state: State = { version: 4, messages: [], activities: [], receipts: [] };
  let working = state;
  const options = { receiptFailure: false, activityFailure: false, messageFailure: false, casFailure: false };
  const trace: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async () => { trace.push("operation-lock"); return []; }),
    task: { updateMany: vi.fn(async ({ where }: { where: { version: number } }) => {
      trace.push("cas");
      if (where.version !== working.version || options.casFailure) return { count: 0 };
      working.version++; return { count: 1 };
    }) },
    taskMoveOperation: {
      findUnique: vi.fn(async ({ where }: { where: { operationId: string } }) => {
        trace.push("receipt-read"); return working.receipts.find(row => row.operationId === where.operationId) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Receipt }) => {
        trace.push("receipt-write"); if (options.receiptFailure) throw new Error("synthetic-private-receipt");
        working.receipts.push(structuredClone(data)); return data;
      }),
    },
    chatMessage: { create: vi.fn(async ({ data }: { data: object }) => {
      trace.push("message"); if (options.messageFailure) throw new Error("synthetic-private-message");
      working.messages.push(structuredClone(data)); return { id: "message-1", createdAt, author: {id: "token-owner", email: "owner@example.invalid", name: "Owner", avatarUrl: null}, reactions: {}, mentions: [], ...data };
    }) },
    activity: { create: vi.fn(async ({ data }: { data: object }) => {
      trace.push("activity"); if (options.activityFailure) throw new Error("synthetic-private-activity");
      working.activities.push(structuredClone(data)); return data;
    }) },
  };
  mocks.database = {
    task: { findFirst: vi.fn(async () => ({ id: "task", projectId: "project" })) },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => {
      working = structuredClone(state);
      const result = await callback(tx);
      state = structuredClone(working); trace.push("commit"); return result;
    },
  };
  mocks.guard.mockImplementation(async () => { trace.push("fresh-access"); return { allowed: true }; });
  const invoke = (overrides: object = {}) => POST(new Request("http://localhost/api/tasks/task/messages", {
    method: "POST", headers: { authorization: "Bearer synthetic-test-token" },
    body: JSON.stringify({ operationId, expectedVersion: 4, contentText: "Synthetic private comment", ...overrides }),
  }), { params: Promise.resolve({ id: "task" }) });
  return { invoke, tx, options, trace, state: () => state };
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.auth.mockResolvedValue({ id: "token-owner", globalRole: "USER" });
  mocks.notify.mockResolvedValue(undefined);mocks.persist.mockResolvedValue([{id:"ordinary-notification"}]);
  mocks.emit.mockResolvedValue(undefined);
});

describe("versioned shared HTTP comment command", () => {
  it("binds bearer owner, persists message/Activity/receipt atomically and replays before stale-version check", async () => {
    const f = fixture(); const first = await f.invoke();
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ data: { messageId: "message-1", taskId: "task", createdAt: createdAt.toISOString(), replayed: false } });
    expect(f.trace).toEqual(["operation-lock", "fresh-access", "receipt-read", "cas", "message", "activity", "receipt-write", "commit"]);
    expect(mocks.auth.mock.calls[0][0].headers.get("authorization")).toBe("Bearer synthetic-test-token");
    expect(mocks.guard).toHaveBeenCalledWith(expect.objectContaining({ actorId: "token-owner", kind: "comment" }));
    expect(f.state().messages[0]).toMatchObject({ authorId: "token-owner" });
    expect(f.state().activities).toEqual([{ taskId: "task", userId: "token-owner", action: "comment_added", oldValue: undefined, newValue: undefined }]);
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith("project", expect.objectContaining({
      id: "message-1", taskId: "task", authorId: "token-owner", visibility: "PUBLIC", isInternal: false,
      author: { id: "token-owner", email: "owner@example.invalid", name: "Owner", avatarUrl: null },
    }));
    const replay = await f.invoke({ operationId: operationId.toUpperCase() });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ data: { messageId: "message-1", createdAt: createdAt.toISOString(), replayed: true } });
    expect(f.state().version).toBe(5);
    expect(f.state().messages).toHaveLength(1); expect(f.state().activities).toHaveLength(1); expect(f.state().receipts).toHaveLength(1);
    expect(f.tx.task.updateMany).toHaveBeenCalledOnce(); expect(mocks.notify).toHaveBeenCalledOnce();
    expect(mocks.emit).toHaveBeenCalledOnce();
  });

  it.each(["payload", "actor", "version"])("rejects operationId reuse with changed %s", async kind => {
    const f = fixture(); expect((await f.invoke()).status).toBe(201);
    if (kind === "actor") mocks.auth.mockResolvedValue({ id: "other-owner", globalRole: "ADMIN" });
    const response = await f.invoke(kind === "payload" ? { contentText: "Other" } : kind === "version" ? { expectedVersion: 5 } : {});
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: "OPERATION_ID_REUSED" } });
    expect(f.state().messages).toHaveLength(1); expect(f.tx.chatMessage.create).toHaveBeenCalledOnce();
  });

  it("rechecks shared permissions before reading any saved receipt", async () => {
    const f = fixture(); await f.invoke(); mocks.guard.mockRejectedValueOnce(new NotFoundError());
    expect((await f.invoke()).status).toBe(404); expect(f.tx.taskMoveOperation.findUnique).toHaveBeenCalledOnce();
    expect(f.tx.chatMessage.create).toHaveBeenCalledOnce(); expect(mocks.notify).toHaveBeenCalledOnce();
  });

  it("rejects internal comments without the common internal permission before any mutation", async () => {
    const f = fixture(); const response = await f.invoke({ visibility: "INTERNAL" });
    expect(response.status).toBe(403); expect(mocks.guard).not.toHaveBeenCalled();
    expect(f.tx.taskMoveOperation.findUnique).not.toHaveBeenCalled();
    expect(f.state()).toEqual({ version: 4, messages: [], activities: [], receipts: [] });
  });

  it("fails closed on a malformed stored acknowledgement", async () => {
    const f = fixture(); await f.invoke(); f.state().receipts[0].response = { taskId: "task", contentText: "synthetic-private" };
    const response = await f.invoke(); expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_RECEIPT" } });
    expect(f.tx.chatMessage.create).toHaveBeenCalledOnce(); expect(mocks.notify).toHaveBeenCalledOnce();
  });

  it("returns committed success if notification delivery fails and never redelivers on replay", async () => {
    const f = fixture(); mocks.notify.mockRejectedValueOnce(new Error("synthetic-private-notification"));
    const response = await f.invoke(); expect(response.status).toBe(201);
    expect(JSON.stringify(await response.json())).not.toContain("synthetic-private");
    expect((await f.invoke()).status).toBe(200); expect(mocks.notify).toHaveBeenCalledOnce();
    expect(f.state().messages).toHaveLength(1); expect(f.state().receipts).toHaveLength(1);
  });

  it("emits only after commit and preserves the committed receipt when realtime fails", async () => {
    const f = fixture();
    mocks.emit.mockImplementationOnce(async () => {
      expect(f.trace.at(-1)).toBe("commit");
      expect(f.state().messages).toHaveLength(1);
      throw new Error("synthetic-private-realtime-failure");
    });
    expect((await f.invoke()).status).toBe(201);
    expect((await f.invoke()).status).toBe(200);
    expect(mocks.emit).toHaveBeenCalledOnce(); expect(mocks.notify).toHaveBeenCalledOnce();
  });

  it.each(["receiptFailure", "activityFailure", "messageFailure", "casFailure"] as const)("rolls back the entire command for %s", async field => {
    const f = fixture(); f.options[field] = true; const response = await f.invoke();
    expect(response.status).toBe(field === "casFailure" ? 409 : 500);
    expect(f.state()).toEqual({ version: 4, messages: [], activities: [], receipts: [] });
    expect(mocks.emit).not.toHaveBeenCalled(); expect(mocks.notify).not.toHaveBeenCalled(); expect(JSON.stringify(await response.json())).not.toContain("synthetic-private");
  });

  it("rejects a stale version before message, Activity or receipt writes", async () => {
    const f = fixture(); const response = await f.invoke({ expectedVersion: 3 });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: "STALE_TASK_VERSION" } });
    expect(f.tx.chatMessage.create).not.toHaveBeenCalled(); expect(f.tx.activity.create).not.toHaveBeenCalled();
    expect(f.tx.taskMoveOperation.create).not.toHaveBeenCalled();
  });

  it.each([{ operationId: null }, { expectedVersion: null }, { expectedVersion: -1 }, { operationId: "invalid" }, { expectedVersion: 2147483647 }])("rejects malformed command %# before auth", async overrides => {
    const f = fixture(); expect((await f.invoke(overrides)).status).toBe(422); expect(mocks.auth).not.toHaveBeenCalled();
  });

  it("rejects a one-sided command before auth", async () => {
    const f = fixture(); expect((await f.invoke({ expectedVersion: undefined })).status).toBe(422);
    expect(mocks.auth).not.toHaveBeenCalled();
  });
});
