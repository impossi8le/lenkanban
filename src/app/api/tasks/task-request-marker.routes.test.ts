import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ transaction: vi.fn(), raw: vi.fn(), task: vi.fn(), actor: vi.fn(), project: vi.fn(), marker: vi.fn(), cas: vi.fn(), activity: vi.fn(), scalarReceipt: vi.fn(), scalarReceiptWrite: vi.fn(), item: vi.fn(), itemWrite: vi.fn(), checklistReceipt: vi.fn(), checklistReceiptWrite: vi.fn(), auth: vi.fn(), load: vi.fn(), emit: vi.fn(), automation: vi.fn(), projection: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: db.transaction } }));
vi.mock("@/lib/require-api-user", async () => ({ requireApiUser: db.auth, UnauthorizedError: (await import("@/lib/errors")).UnauthorizedError }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: db.log, warn: db.log, error: db.log }, dbLogger: { error: db.log } }));
vi.mock("@/lib/task-queries", () => ({ loadTaskWithRelations: db.load, TASK_WITH_RELATIONS_INCLUDE: {} }));
vi.mock("@/socket/board-events", () => ({ emitTaskUpdated: db.emit, emitTaskDeleted: vi.fn(), emitTaskMoved: vi.fn() }));
vi.mock("@/lib/automation-processor", () => ({ processAutomationRules: db.automation }));
vi.mock("@/lib/notification-triggers", () => ({ notifyTaskStatusChanged: vi.fn() }));
vi.mock("@/lib/telemetry/store", () => ({ projectChecklistTelemetry: db.projection }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: vi.fn(), rateLimitErrorResponse: () => new Response("{}", { status: 429 }) }));
import { PATCH as scalarPATCH } from "./[id]/route";
import { PATCH as checklistPATCH } from "./[id]/checklist/[itemId]/route";
import { UnauthorizedError } from "@/lib/errors";

const operationId = "11111111-1111-4111-8111-111111111111";
const marker = { taskId: "task", contractVersion: 1, state: "DRAFT", authorId: "private-author", executorId: null };
const scalarBody = { operationId, expectedVersion: 3, changes: { title: "Updated" } };
const tx = { $queryRaw: db.raw, task: { findUnique: db.task, updateMany: db.cas }, user: { findUnique: db.actor }, project: { findUnique: db.project }, taskRequest: { findUnique: db.marker }, activity: { create: db.activity }, taskCommandOperation: { findUnique: db.scalarReceipt, create: db.scalarReceiptWrite }, taskChecklistItem: { findFirst: db.item, update: db.itemWrite }, checklistOperationReceipt: { findUnique: db.checklistReceipt, create: db.checklistReceiptWrite } };
function invoke(kind: "scalar" | "toggle" | "legacy") {
  const scalar = kind === "scalar";
  const request = new Request(`https://app.test/api/tasks/task${scalar ? "" : "/checklist/item"}`, { method: "PATCH", headers: { origin: "https://app.test", "content-type": "application/json", ...(kind === "toggle" ? { "X-Operation-Id": operationId } : {}) }, body: JSON.stringify(scalar ? scalarBody : kind === "toggle" ? { completed: true } : { text: "New private text", position: 9 }) });
  return scalar ? scalarPATCH(request, { params: Promise.resolve({ id: "task" }) }) : checklistPATCH(request, { params: Promise.resolve({ id: "task", itemId: "item" }) });
}
function noBusinessWritesOrEffects() {
  for (const method of [db.cas, db.activity, db.scalarReceiptWrite, db.itemWrite, db.checklistReceiptWrite, db.load, db.emit, db.automation, db.projection]) expect(method).not.toHaveBeenCalled();
}
beforeEach(() => {
  for (const name of ["NEXT_PUBLIC_APP_URL", "APP_URL", "NEXTAUTH_URL"]) vi.stubEnv(name, undefined);
  // A privileged legacy writer reaches the marker boundary; this capability
  // still cannot bypass a marked request or malformed stored lifecycle data.
  vi.resetAllMocks(); db.auth.mockResolvedValue({ id: "actor", globalRole: "ADMIN" }); db.actor.mockResolvedValue({ id: "actor", globalRole: "ADMIN" });
  db.project.mockResolvedValue({ id: "project", ownerId: "actor", members: [] }); db.marker.mockResolvedValue(marker); db.raw.mockResolvedValue([{ id: "locked" }]);
  db.task.mockResolvedValue({ id: "task", projectId: "project", columnId: "column", title: "Original", description: null, priority: "MEDIUM", deadline: null, version: 3 });
  db.transaction.mockImplementation(async callback => callback(tx));
});
afterEach(() => vi.unstubAllEnvs());

describe.each(["scalar", "toggle", "legacy"] as const)("%s HTTP request-marker boundary with actual services", kind => {
  it.each(["marked", "malformed"])("returns safe409 for %s without effects or receipt lookup", async shape => {
    if (shape === "malformed") db.marker.mockResolvedValue({ ...marker, privateSecret: "raw-marker-secret" });
    const response = await invoke(kind); expect(response.status).toBe(409);
    const json = await response.text(); expect(json).not.toMatch(/private-author|executorId|authorId|raw-marker-secret|contractVersion|DRAFT|New private text/);
    if (kind === "scalar") expect(response.headers.get("cache-control")).toBe("no-store");
    expect(db.scalarReceipt).not.toHaveBeenCalled(); expect(db.checklistReceipt).not.toHaveBeenCalled(); noBusinessWritesOrEffects();
  });
  it("keeps a fresh outsider404 ahead of marker inspection", async () => {
    db.actor.mockResolvedValue({ id: "actor", globalRole: "USER" });
    db.project.mockResolvedValue({ id: "project", ownerId: "other", members: [] }); const response = await invoke(kind);
    expect(response.status).toBe(404); expect(db.marker).not.toHaveBeenCalled(); noBusinessWritesOrEffects();
  });
  it("keeps unauthenticated401 ahead of any transaction or marker access", async () => {
    db.auth.mockRejectedValue(new UnauthorizedError()); expect((await invoke(kind)).status).toBe(401); expect(db.transaction).not.toHaveBeenCalled(); expect(db.marker).not.toHaveBeenCalled(); noBusinessWritesOrEffects();
  });
  it("uses safe500 when storage rejects instead of assuming unmarked legacy data", async () => {
    db.marker.mockRejectedValue(Error("private-marker-database-error")); const response = await invoke(kind);
    expect(response.status).toBe(500); expect(await response.text()).not.toContain("private-marker-database-error"); noBusinessWritesOrEffects();
  });
});
