import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/request-queue-unseen", () => ({ readRequestQueueArrivalMap: async (_db: unknown, _actor: string, ids: string[]) => new Map(ids.map(id => [id, null])) }));
const mocks = vi.hoisted(() => ({ actor: vi.fn(), freshActor: vi.fn(), transaction: vi.fn(), access: vi.fn(), save: vi.fn(), taskRead: vi.fn(), legacyRead: vi.fn(), legacyWrite: vi.fn(), readAccess: vi.fn(), load: vi.fn(), emit: vi.fn(), automation: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.transaction, task: { findUnique: mocks.taskRead, findFirst: mocks.legacyRead, update: mocks.legacyWrite } } }));
vi.mock("@/lib/require-api-user", async () => ({ requireApiUser: mocks.actor, UnauthorizedError: (await import("@/lib/errors")).UnauthorizedError }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: mocks.info, warn: mocks.warn, error: mocks.error }, dbLogger: { error: mocks.error } }));
vi.mock("@/lib/task-command", async original => ({ ...await original<typeof import("@/lib/task-command")>(), createTaskCommandService: () => ({ saveDetails: mocks.save }) }));
vi.mock("@/lib/project-access", async original => ({ ...await original<typeof import("@/lib/project-access")>(), requireProjectRead: mocks.readAccess, getProjectAccess: mocks.access }));
vi.mock("@/lib/task-queries", () => ({ loadTaskWithRelations: mocks.load, TASK_WITH_RELATIONS_INCLUDE: { assignees: true, tags: true, checklistItems: true } }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: mocks.emit, emitTaskDeleted: vi.fn(), emitTaskMoved: vi.fn() }));
vi.mock("@/lib/notification-triggers", () => ({ notifyTaskStatusChanged: vi.fn() }));
vi.mock("@/lib/automation-processor", () => ({ processAutomationRules: mocks.automation }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: vi.fn(), rateLimitErrorResponse: () => new Response("{}", { status: 429 }) }));
import { NotFoundError, UnauthorizedError } from "@/lib/errors";
import { taskReadPredicate } from "@/lib/access-policy";
import { TaskCommandError } from "@/lib/task-command";
import { PATCH, GET } from "./[id]/route";

const path = "https://app.test/api/tasks/task";
const body = { operationId: "11111111-1111-4111-8111-111111111111", expectedVersion: 3, changes: { title: "Updated" } };
const ack = { taskId: "task", projectId: "project", version: 4, changed: true, replayed: false };
const context = () => ({ params: Promise.resolve({ id: "task" }) });
function request(value: unknown = body) { return new Request(path, { method: "PATCH", headers: { origin: "https://app.test", "content-type": "application/json" }, body: JSON.stringify(value) }); }
const patch = (input = request()) => PATCH(input, context());
function safe(response: Response) { expect(response.headers.get("cache-control")).toBe("no-store"); }
function noFallback() { expect(mocks.legacyRead).not.toHaveBeenCalled(); expect(mocks.legacyWrite).not.toHaveBeenCalled(); }
beforeEach(() => {
  for (const name of ["NEXT_PUBLIC_APP_URL", "APP_URL", "NEXTAUTH_URL"]) vi.stubEnv(name, undefined);
  vi.resetAllMocks(); vi.stubEnv("TELEMETRY_ENABLED", "false"); mocks.actor.mockResolvedValue({ id: "actor", globalRole: "USER" }); mocks.save.mockResolvedValue({ ack, effects: null }); mocks.legacyRead.mockResolvedValue(null); mocks.readAccess.mockResolvedValue({ canRead: true });
  mocks.freshActor.mockResolvedValue({ id: "actor", globalRole: "USER" }); mocks.access.mockResolvedValue({ canRead: true });
  mocks.transaction.mockImplementation(async operation => operation({ user: { findUnique: mocks.freshActor }, task: { findFirst: mocks.taskRead } }));
  const task = { id: "task", title: "Authoritative current title", projectId: "project", project: { id: "project", name: "Board" }, columnId: "column", status: "TODO", position: 1024, createdAt: new Date("2026-10-20T00:00:00Z"), updatedAt: new Date("2026-10-21T00:00:00Z"), version: 9, description: "Current description", priority: "LOW", deadline: null, assignees: [], tags: [], checklistItems: [], passwordHash: "synthetic-private-password", applicantPolicyConfig: { policy: "private-policy" } };
  mocks.taskRead.mockResolvedValue(task); mocks.load.mockResolvedValue(task);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("instrumented Task scalar PATCH transport, distinct from legacy mixed PATCH", () => {
  it("authenticates before body and path even for malformed command input", async () => {
    mocks.actor.mockRejectedValue(new UnauthorizedError()); const input = request({ operationId: null }); const read = vi.spyOn(input.body!, "getReader"); const then = vi.fn(() => { throw Error("Must authenticate first"); });
    const response = await PATCH(input, { params: { then } as unknown as Promise<{ id: string }> }); expect(response.status).toBe(401); safe(response); expect(read).not.toHaveBeenCalled(); expect(then).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled(); noFallback();
  });
  it("forwards only actor/path and strict scalar command, returning content-free ACK", async () => {
    const response = await patch(); expect(response.status).toBe(200); safe(response); expect(await response.json()).toEqual({ success: true, data: ack });
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ actorId: "actor", taskId: "task", ...body }); noFallback();
  });
  it.each([
    { operationId: null, title: "Legacy trap" }, { changes: null, title: "Legacy trap" },
    { ...body, operationId: "bad" }, { operationId: body.operationId, expectedVersion: 3, title: "Legacy trap" },
    { expectedVersion: 3, changes: {} }, { ...body, changes: { title: "Updated", status: "DONE" } },
    { ...body, changes: { columnId: "other" } }, { ...body, changes: { position: 4 } }, { ...body, actorId: "other" },
  ])("rejects malformed instrumented input without legacy fallback %#", async value => {
    const response = await patch(request(value)); expect(response.status).toBe(400); safe(response); expect(mocks.save).not.toHaveBeenCalled(); noFallback();
  });
  it("keeps metadata-free flat legacy PATCH in its historical path", async () => {
    const response = await patch(request({ title: "Legacy title" })); expect(response.status).toBe(404); expect(mocks.legacyRead).toHaveBeenCalledOnce(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each(["projectId", "createdById", "authorId", "executorId", "assigneeId", "attachments", "request"])("rejects %s at both levels of a details command", async field => {
    for (const value of [
      { ...body, [field]: "synthetic-private-value" },
      { ...body, changes: { description: "Synthetic description", [field]: "synthetic-private-value" } },
    ]) {
      const response = await patch(request(value));
      expect(response.status).toBe(400);
      safe(response);
      expect(await response.text()).not.toMatch(/synthetic-private-value|Synthetic description/);
      expect(mocks.save).not.toHaveBeenCalled();
      noFallback();
    }
  });
  it.each(["foreign", "cookie-missing", "cross-site-bearer"])("blocks %s Origin before instrumented command execution", async scenario => {
    const input = request(); if (scenario === "foreign") input.headers.set("origin", "https://foreign.invalid"); else input.headers.delete("origin");
    if (scenario === "cross-site-bearer") { input.headers.set("authorization", "Bearer synthetic-verified-token"); input.headers.set("sec-fetch-site", "cross-site"); }
    const response = await patch(input); expect(response.status).toBe(403); safe(response); expect(mocks.save).not.toHaveBeenCalled(); noFallback();
  });
  it("permits a previously verified bearer without Origin for a valid command", async () => {
    const input = request(); input.headers.delete("origin"); input.headers.set("authorization", "Bearer synthetic-verified-token"); expect((await patch(input)).status).toBe(200); expect(mocks.save).toHaveBeenCalledOnce();
  });
  it("accepts a valid details payload above16KiB and enforces the command256KiB maximum", async () => {
    const valid = request({ ...body, changes: { description: "x".repeat(50000) } }); expect((await patch(valid)).status).toBe(200); mocks.save.mockClear();
    expect((await patch(request({ ...body, raw: "x".repeat(270000) }))).status).toBe(413); expect(mocks.save).not.toHaveBeenCalled(); noFallback();
  });
  it("bounds a stalled request body at five seconds without command or legacy write", async () => {
    vi.useFakeTimers(); const cancel = vi.fn(); const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}), cancel });
    const input = new Request(path, { method: "PATCH", headers: { origin: "https://app.test", "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit);
    const pending = patch(input); await vi.advanceTimersByTimeAsync(5001); const response = await pending; expect(response.status).toBe(408); safe(response); expect(cancel).toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled(); noFallback();
  });
  it.each(["OPERATION_ID_REUSED", "INVALID_RECEIPT", "STALE_TASK_VERSION", "VERSION_EXHAUSTED", "IDENTITY_CHANGED"] as const)("maps %s to fixed409 without raw task contents", async code => {
    mocks.save.mockRejectedValue(new TaskCommandError(code)); const response = await patch(); expect(response.status).toBe(409); safe(response); expect(await response.text()).not.toContain("Updated"); noFallback();
  });
  it("preserves missing/denied as404 and unexpected errors as safe500", async () => {
    for (const [failure, status] of [[new NotFoundError(), 404], [Error("synthetic-private-description"), 500]] as const) {
      mocks.save.mockRejectedValue(failure); const response = await patch(); expect(response.status).toBe(status); safe(response); expect(await response.text()).not.toContain("synthetic-private");
    }
  });
  it("passes through a historical replay ACK without treating it as current task data or repeating effects", async () => {
    mocks.save.mockResolvedValue({ ack: { ...ack, version: 1, replayed: true }, effects: null }); const response = await patch();
    expect(await response.json()).toEqual({ success: true, data: { ...ack, version: 1, replayed: true } }); expect(mocks.emit).not.toHaveBeenCalled(); expect(mocks.automation).not.toHaveBeenCalled();
  });
  it("waits for command completion before automations and emits the current task after both triggers", async () => {
    let commit!: (value: unknown) => void;
    mocks.save.mockReturnValue(new Promise(resolve => { commit = resolve; }));
    const pending = patch(); await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.automation).not.toHaveBeenCalled(); expect(mocks.emit).not.toHaveBeenCalled();
    const deadline = "2026-11-01T12:00:00.000Z";
    commit({ ack, effects: { priority: { oldValue: "LOW", newValue: "HIGH" }, deadlineSet: deadline } });
    const response = await pending; expect(await response.json()).toEqual({ success: true, data: ack }); safe(response);
    expect(mocks.automation).toHaveBeenNthCalledWith(1, expect.objectContaining({ trigger: "priority_changed", userId: "actor", oldValue: "LOW", newValue: "HIGH" }));
    expect(mocks.automation).toHaveBeenNthCalledWith(2, expect.objectContaining({ trigger: "deadline_set", newValue: new Date(deadline) }));
    expect(mocks.emit).toHaveBeenCalledExactlyOnceWith("project", expect.objectContaining({ version: 9 }));
  });
  it.each(["automation", "emit", "load"] as const)("keeps the committed ACK when %s fails", async failure => {
    mocks.save.mockResolvedValue({ ack, effects: { priority: { oldValue: "LOW", newValue: "HIGH" }, deadlineSet: "2026-11-01T12:00:00.000Z" } });
    mocks[failure].mockRejectedValueOnce(Error("synthetic-private-effect"));
    const response = await patch(); expect(response.status).toBe(200); safe(response); expect(await response.json()).toEqual({ success: true, data: ack });
    if (failure === "automation") { expect(mocks.automation).toHaveBeenCalledTimes(2); expect(mocks.emit).toHaveBeenCalledOnce(); }
  });
  it("does not load or emit for a no-op receipt", async () => {
    mocks.save.mockResolvedValue({ ack: { ...ack, version: 3, changed: false }, effects: null });
    expect((await patch()).status).toBe(200); expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.automation).not.toHaveBeenCalled(); expect(mocks.emit).not.toHaveBeenCalled();
  });
});

describe("authoritative Task details read", () => {
  it("reads current version after an old ACK using fresh actor and a closed DTO", async () => {
    const current = await mocks.taskRead(); mocks.taskRead.mockClear();
    mocks.taskRead.mockResolvedValue({ ...current, assignees: [{ id: "assignment", user: { id: "assignee", name: "Public name", email: "synthetic@example.invalid", avatarUrl: null, globalRole: "ADMIN", passwordHash: "synthetic-private-nested" } }] });
    mocks.save.mockResolvedValue({ ack: { ...ack, version: 1, replayed: true }, effects: null });
    expect((await (await patch()).json()).data.version).toBe(1);
    const response = await GET(new Request(`${path}?view=details`), context()); safe(response); expect(response.status).toBe(200);
    const payload = await response.json(); expect(payload.data).toMatchObject({ version: 9, title: "Authoritative current title", description: "Current description" });
    expect(JSON.stringify(payload)).not.toMatch(/synthetic-private|private-policy|passwordHash|applicantPolicyConfig|globalRole/);
    expect(Object.keys(payload.data.assignees[0].user).sort()).toEqual(["avatarUrl", "email", "id", "name"]);
    expect(mocks.freshActor).toHaveBeenCalledExactlyOnceWith({ where: { id: "actor" }, select: { id: true, globalRole: true } });
    expect(mocks.taskRead).toHaveBeenCalledExactlyOnceWith({ where: { AND: [taskReadPredicate({ id: "actor", globalRole: "USER" }, [], [], true), { id: "task" }] }, include: { assignees: true, tags: true, checklistItems: true } });
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.freshActor.mock.invocationCallOrder[0]).toBeLessThan(mocks.taskRead.mock.invocationCallOrder[0]);
  });
  it.each(["view=details&view=details", "view=other", "view=details&raw=true"])("rejects malformed view %s before a database read", async query => {
    const response = await GET(new Request(`${path}?${query}`), context()); expect(response.status).toBe(400); safe(response); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("authenticates before resolving details path or opening a transaction", async () => {
    mocks.actor.mockRejectedValue(new UnauthorizedError()); const then = vi.fn();
    const response = await GET(new Request(`${path}?view=details`), { params: { then } as unknown as Promise<{ id: string }> });
    expect(response.status).toBe(401); safe(response); expect(then).not.toHaveBeenCalled(); expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(["actor", "task", "access"])("hides details when fresh %s is absent or denied", async missing => {
    if (missing === "actor") mocks.freshActor.mockResolvedValue(null); else if (missing === "task") mocks.taskRead.mockResolvedValue(null); else mocks.taskRead.mockResolvedValue(null);
    const response = await GET(new Request(`${path}?view=details`), context()); expect(response.status).toBe(404); safe(response); expect(await response.text()).not.toContain("Current description");
  });
});
