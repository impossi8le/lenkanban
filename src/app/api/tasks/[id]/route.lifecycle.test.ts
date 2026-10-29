import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError, UnauthorizedError } from "@/lib/errors";
import { TaskLifecycleError } from "@/features/kanban/server/task-lifecycle-service";

const runtime = vi.hoisted(() => ({
  auth: vi.fn(),
  rate: vi.fn(),
  transition: vi.fn(),
  emitUpdated: vi.fn(),
  reasonMessage:vi.fn(),emitMessage:vi.fn(),
  notifyAssigned: vi.fn(),
  notifyTakenOver: vi.fn(),
  actorName: vi.fn(),
  load: vi.fn(),
  log: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: { user: { findUnique: runtime.actorName },chatMessage:{findFirst:runtime.reasonMessage} } }));
vi.mock("@/lib/require-api-user", async () => ({
  requireApiUser: runtime.auth,
  UnauthorizedError: (await import("@/lib/errors")).UnauthorizedError,
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimitOrThrowKey: runtime.rate,
  rateLimitErrorResponse: () => Response.json({ error: { code: "RATE_LIMITED" } }, { status: 429 }),
}));
vi.mock("@/lib/task-queries", () => ({
  loadTaskWithRelations: runtime.load,
  TASK_WITH_RELATIONS_INCLUDE: {},
}));
vi.mock("@/socket/board-events", () => ({
  emitTaskUpdated: runtime.emitUpdated,
  emitTaskMessageCreated:runtime.emitMessage,
  emitTaskMoved: vi.fn(),
  emitTaskDeleted: vi.fn(),
}));
vi.mock("@/lib/notification-triggers", () => ({ notifyTaskStatusChanged: vi.fn(), notifyTaskAssigned: runtime.notifyAssigned, notifyTaskTakenOver: runtime.notifyTakenOver }));
vi.mock("@/lib/automation-processor", () => ({ processAutomationRules: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  apiLogger: { info: runtime.log, warn: runtime.log, error: runtime.log },
  dbLogger: { error: vi.fn() },
}));
vi.mock("@/features/kanban/server/task-lifecycle-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/kanban/server/task-lifecycle-service")>();
  return {
    ...actual,
    createTaskLifecycleService: () => ({ transition: runtime.transition }),
  };
});

import { POST } from "./route";

const ack = {
  taskId: "task",
  projectId: "project",
  version: 4,
  state: "SUBMITTED" as const,
  executorId: null,
  changed: true,
  replayed: false,
};
const effects = {
  action: "submit" as const,
  previousState: "DRAFT" as const,
  previousExecutorId: null,
  state: "SUBMITTED" as const,
  executorId: null,
};
const body = {
  operationId: "11111111-1111-4111-8111-111111111111",
  expectedVersion: 3,
  action: "submit",
};

function invoke(value: unknown = body, init: { headers?: Record<string, string>; raw?: string; url?: string } = {}) {
  const request = new Request(init.url ?? "https://app.test/api/tasks/task", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test", ...init.headers },
    body: init.raw ?? JSON.stringify(value),
  });
  return POST(request, { params: Promise.resolve({ id: "task" }) });
}

beforeEach(() => {
  for (const name of ["NEXT_PUBLIC_APP_URL", "APP_URL", "NEXTAUTH_URL"]) vi.stubEnv(name, undefined);
  vi.clearAllMocks();
  // Production configures NEXTAUTH_URL; the guard compares Origin with it.
  vi.stubEnv("NEXTAUTH_URL", "https://app.test");
  runtime.auth.mockResolvedValue({ id: "author", name: "Author", email: "author@example.test", globalRole: "USER" });
  runtime.rate.mockResolvedValue(undefined);
  runtime.transition.mockResolvedValue({ ack, effects });
  runtime.load.mockResolvedValue({ id: "task", project: { id: "project" } });
  runtime.emitUpdated.mockResolvedValue(undefined);
  runtime.notifyAssigned.mockResolvedValue(undefined);
  runtime.actorName.mockResolvedValue({ name: "Fresh actor name" });
  runtime.log.mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/tasks/[id] lifecycle boundary", () => {
  it("delivers takeover only for committed first application and preserves ACK on notification failure", async () => {
    const takeover = { ack: { ...ack, state: "NEEDS_INFO", executorId: "author" },
      effects: { ...effects, action: "take_over", previousState: "NEEDS_INFO", previousExecutorId: "colleague", state: "NEEDS_INFO", executorId: "author" } };
    runtime.transition.mockResolvedValue(takeover);
    runtime.notifyTakenOver.mockRejectedValueOnce(new Error("synthetic-delivery-failure"));
    expect((await invoke({ ...body, action: "take_over" })).status).toBe(200);
    expect(runtime.notifyTakenOver).toHaveBeenCalledExactlyOnceWith({ taskId: "task", projectId: "project", previousExecutorId: "colleague", actorId: "author", actorName: "Fresh actor name" });
    runtime.transition.mockResolvedValue({ ack: { ...takeover.ack, replayed: true }, effects: null });
    expect((await invoke({ ...body, action: "take_over" })).status).toBe(200);
    expect(runtime.notifyTakenOver).toHaveBeenCalledOnce();
    expect(runtime.notifyAssigned).not.toHaveBeenCalled();
  });
  const assignment = {
    ack: { ...ack, state: "IN_PROGRESS", executorId: "new-executor" },
    effects: { ...effects, action: "assign", previousState: "IN_PROGRESS", previousExecutorId: "old-executor", state: "IN_PROGRESS", executorId: "new-executor" },
  };
  const assignBody = { ...body, action: "assign", assigneeId: "new-executor" };

  it("notifies the new executor only after a committed changed assignment using current title and fresh actor name", async () => {
    let commit!: (value: typeof assignment) => void;
    runtime.transition.mockReturnValue(new Promise(resolve => { commit = resolve; }));
    runtime.load.mockResolvedValue({ id: "task", title: "Current canonical title", project: { id: "project" } });
    const pending = invoke(assignBody);
    await vi.waitFor(() => expect(runtime.transition).toHaveBeenCalledOnce());
    expect(runtime.notifyAssigned).not.toHaveBeenCalled();
    commit(assignment);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: assignment.ack });
    expect(runtime.actorName).toHaveBeenCalledExactlyOnceWith({ where: { id: "author" }, select: { name: true } });
    expect(runtime.notifyAssigned).toHaveBeenCalledExactlyOnceWith({ taskId: "task", taskTitle: "Current canonical title", projectId: "project",
      assigneeId: "new-executor", assignedById: "author", assignedByName: "Fresh actor name" });
  });

  it.each(["replay", "noop"])("does not repeat assignment notifications for %s with no effects", async kind => {
    runtime.transition.mockResolvedValue({ ack: { ...assignment.ack, changed: kind !== "noop", replayed: kind === "replay" }, effects: null });
    expect((await invoke(assignBody)).status).toBe(200);
    expect(runtime.load).not.toHaveBeenCalled();
    expect(runtime.notifyAssigned).not.toHaveBeenCalled();
    expect(runtime.actorName).not.toHaveBeenCalled();
  });

  it.each(["sync", "async"])("still notifies when the independent board emit fails %s", async mode => {
    runtime.transition.mockResolvedValue(assignment);
    runtime.load.mockResolvedValue({ id: "task", title: "Current canonical title", project: { id: "project" } });
    if (mode === "sync") runtime.emitUpdated.mockImplementation(() => { throw new Error("synthetic-board-failure"); });
    else runtime.emitUpdated.mockRejectedValue(new Error("synthetic-board-failure"));
    const response = await invoke(assignBody);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: assignment.ack });
    expect(runtime.notifyAssigned).toHaveBeenCalledOnce();
  });

  it.each(["sync", "async"])("preserves committed ACK and board delivery when notification fails %s", async mode => {
    runtime.transition.mockResolvedValue(assignment);
    if (mode === "sync") runtime.notifyAssigned.mockImplementation(() => { throw new Error("synthetic-notification-failure"); });
    else runtime.notifyAssigned.mockRejectedValue(new Error("synthetic-notification-failure"));
    const response = await invoke(assignBody);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: assignment.ack });
    expect(runtime.emitUpdated).toHaveBeenCalledOnce();
    expect(runtime.log).toHaveBeenCalledWith(expect.objectContaining({ event: "task.lifecycle.effects.failed" }));
  });

  it.each([null, { name: null }, { name: "   " }])("uses a generic actor label without copying stale session/email when no current name exists %#", async actor => {
    runtime.transition.mockResolvedValue(assignment);
    runtime.actorName.mockResolvedValue(actor);
    expect((await invoke(assignBody)).status).toBe(200);
    expect(runtime.notifyAssigned).toHaveBeenCalledWith(expect.objectContaining({ assignedByName: "Участник" }));
  });

  it.each([
    { ...assignment, ack: { ...assignment.ack, changed: false } },
    { ...assignment, ack: { ...assignment.ack, replayed: true } },
    { ...assignment, effects: { ...assignment.effects, executorId: null } },
    { ...assignment, effects: { ...assignment.effects, previousExecutorId: "new-executor" } },
    { ...assignment, effects: { ...assignment.effects, action: "take" } },
  ])("suppresses notification when the assignment did not create a new executor %#", async result => {
    runtime.transition.mockResolvedValue(result);
    expect((await invoke(assignBody)).status).toBe(200);
    expect(runtime.notifyAssigned).not.toHaveBeenCalled();
  });
  it("accepts configured public Origin with an internal reverse proxy URL", async () => {
    const response = await invoke(body, { url: "http://localhost:3000/api/tasks/task" });
    expect(response.status).toBe(200);
    expect(runtime.transition).toHaveBeenCalledWith({ actorId: "author", taskId: "task", ...body });
  });

  it("rejects a foreign proxy Origin even with attacker supplied forwarding headers", async () => {
    const response = await invoke(body, {
      url: "http://localhost:3000/api/tasks/task",
      headers: { origin: "https://evil.test", "x-forwarded-host": "evil.test", "x-forwarded-proto": "https" },
    });
    expect(response.status).toBe(403);
    expect(runtime.transition).not.toHaveBeenCalled();
    expect(runtime.emitUpdated).not.toHaveBeenCalled();
  });

  it("commits one transition and emits the committed card after the ACK", async () => {
    const response = await invoke();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ success: true, data: ack });
    expect(runtime.transition).toHaveBeenCalledWith({ actorId: "author", taskId: "task", ...body });
    expect(runtime.load).toHaveBeenCalledWith("task");
    expect(runtime.emitUpdated).toHaveBeenCalledWith("project", { id: "task", project: { id: "project" } });
  });

  it("does not emit when a replay has no effects", async () => {
    runtime.transition.mockResolvedValue({ ack: { ...ack, replayed: true }, effects: null });
    const response = await invoke();
    expect(response.status).toBe(200);
    expect(runtime.emitUpdated).not.toHaveBeenCalled();
  });

  it("preserves the committed ACK when realtime delivery fails", async () => {
    runtime.emitUpdated.mockRejectedValue(new Error("synthetic-delivery"));
    const response = await invoke();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: ack });
    expect(runtime.log).toHaveBeenCalledWith(expect.objectContaining({ event: "task.lifecycle.effects.failed" }));
  });

  it.each([
    ["FORBIDDEN_ROLE", 403],
    ["INVALID_TRANSITION", 409],
    ["ASSIGNEE_REQUIRED", 422],
    ["ASSIGNEE_NOT_ELIGIBLE", 422],
    ["REASON_REQUIRED", 422],
    ["RESPONSE_REQUIRED", 422],
    ["DESCRIPTION_REQUIRED", 422],
    ["INVALID_REQUEST_MARKER", 409],
    ["NOT_A_REQUEST", 404],
    ["STALE_TASK_VERSION", 409],
    ["VERSION_EXHAUSTED", 409],
    ["OPERATION_ID_REUSED", 409],
    ["INVALID_RECEIPT", 409],
    ["INVALID_COMMAND", 400],
    ["INVALID_LIFECYCLE_ACTION", 400],
  ])("maps %s to a fixed %i without external effects", async (code, status) => {
    runtime.transition.mockRejectedValue(new TaskLifecycleError(code as TaskLifecycleError["code"]));
    const response = await invoke();
    expect(response.status).toBe(status);
    const json = await response.json();
    expect(json.error.code).toBe(code);
    expect(JSON.stringify(json)).not.toMatch(/synthetic|description|reason|comment/);
    expect(runtime.emitUpdated).not.toHaveBeenCalled();
  });

  it("maps auth, not-found and infrastructure failures safely", async () => {
    runtime.auth.mockRejectedValueOnce(new UnauthorizedError());
    expect((await invoke()).status).toBe(401);
    runtime.transition.mockRejectedValueOnce(new NotFoundError());
    const missing = await invoke();
    expect(missing.status).toBe(404);
    runtime.transition.mockRejectedValueOnce(new Error("synthetic-private"));
    const failed = await invoke();
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toMatch(/synthetic-private/);
    expect(runtime.emitUpdated).not.toHaveBeenCalled();
  });

  it("rejects a foreign origin before the service", async () => {
    const response = await invoke(body, { headers: { origin: "https://evil.test" } });
    expect(response.status).toBe(403);
    expect(runtime.transition).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON content type with 415", async () => {
    const response = await invoke(body, { headers: { "content-type": "text/plain" } });
    expect(response.status).toBe(415);
    expect(runtime.transition).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with a safe 400", async () => {
    const response = await invoke(null, { raw: "{not-json" });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_JSON");
    expect(runtime.transition).not.toHaveBeenCalled();
  });

  it.each([
    { ...body, projectId: "other-project" },
    { ...body, columnId: "other-column" },
    { ...body, action: "assign" },
    { ...body, action: "submit", assigneeId: "member" },
    { ...body, action: "unknown" },
  ])("rejects forbidden or incomplete fields before the service %#", async (value) => {
    const response = await invoke(value);
    expect(response.status).toBe(400);
    expect(runtime.transition).not.toHaveBeenCalled();
  });

  it("applies the existing update rate limit", async () => {
    runtime.rate.mockRejectedValue(new Error("limit"));
    const response = await invoke();
    expect(response.status).toBe(429);
    expect(runtime.transition).not.toHaveBeenCalled();
    expect(runtime.rate).toHaveBeenCalledWith("tasks:update", "author");
  });
});

it("emits the committed public return reason via the shared fresh chat bridge and does not duplicate on replay",async()=>{
 runtime.transition.mockResolvedValue({ack:{...ack,state:"IN_PROGRESS",executorId:"accountant"},effects:{...effects,action:"return_for_revision",reasonMessageId:"reason",state:"IN_PROGRESS",executorId:"accountant"}});
 runtime.reasonMessage.mockResolvedValue({id:"reason",taskId:"task",contentText:"Исправить сумму",attachments:[],mentions:[],reactions:{},deletedAt:null,author:{id:"author",name:"Author",email:"author@example.invalid",avatarUrl:null}});
 expect((await invoke({...body,action:"return_for_revision",reason:"Исправить сумму"})).status).toBe(200);
 expect(runtime.emitMessage).toHaveBeenCalledExactlyOnceWith("project",expect.objectContaining({id:"reason",contentText:"Исправить сумму",visibility:"PUBLIC",isInternal:false}));
 expect(runtime.reasonMessage).toHaveBeenCalledWith(expect.objectContaining({where:{id:"reason",taskId:"task"}}));
 runtime.transition.mockResolvedValue({ack:{...ack,replayed:true},effects:null});await invoke({...body,action:"return_for_revision",reason:"Исправить сумму"});expect(runtime.emitMessage).toHaveBeenCalledTimes(1);
});
it("a failed reason realtime effect preserves the committed return ACK",async()=>{
 runtime.transition.mockResolvedValue({ack,effects:{...effects,action:"return_for_revision",reasonMessageId:"reason"}});
 runtime.reasonMessage.mockRejectedValue(new Error("synthetic-realtime"));expect((await invoke({...body,action:"return_for_revision",reason:"Исправить"})).status).toBe(200);expect(runtime.emitUpdated).toHaveBeenCalled();
});
