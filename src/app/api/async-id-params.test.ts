import { NextRequest } from "next/server";
import { taskReadPredicate } from "@/lib/access-policy";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const model = () => ({ findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), delete: vi.fn(), updateMany: vi.fn() });
  return {
    requireApiUser: vi.fn(), getServerSession: vi.fn(), rateLimit: vi.fn(),
    txRecurringTask: model(), transaction: vi.fn(), raw: vi.fn(), accountStatus: vi.fn(),
    prisma: {
      taskTemplate: model(), automationRule: model(), recurringTask: model(),
      savedView: model(), projectTemplate: model(), notification: model(),
      // Notification visibility resolves the linked task through the shared read predicate.
      task: { findFirst: vi.fn() },
      project: { create: vi.fn(), findUnique: vi.fn() }, user: { findUnique: vi.fn() }, projectColumn: { findFirst: vi.fn() },
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: { ...mocks.prisma, $transaction: mocks.transaction, $queryRaw: mocks.accountStatus } }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/rate-limit")>(), rateLimitOrThrowKey: mocks.rateLimit,
}));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: mocks.requireApiUser,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock("next-auth", () => ({ getServerSession: mocks.getServerSession }));
vi.mock("@/lib/nextauth", () => ({ nextAuthOptions: {} }));
vi.mock("@/socket/board-events", () => ({ emitTaskCreated: vi.fn(), emitUserNotificationChanged:vi.fn() }));

import { UnauthorizedError } from "@/lib/require-api-user";
import * as templates from "./templates/[id]/route";
import * as useTemplate from "./templates/[id]/use/route";
import * as savedViews from "./saved-views/[id]/route";
import * as automationRules from "./automation-rules/[id]/route";
import * as recurringTasks from "./recurring-tasks/[id]/route";
import * as projectTemplates from "./project-templates/[id]/route";
import * as useProjectTemplate from "./project-templates/[id]/use/route";
import * as notifications from "./notifications/[id]/route";

const cases = [
  { path: "templates", method: "GET", handler: templates.GET, model: "taskTemplate" },
  { path: "templates", method: "PATCH", handler: templates.PATCH, model: "taskTemplate" },
  { path: "templates", method: "DELETE", handler: templates.DELETE, model: "taskTemplate" },
  { path: "templates/use", method: "POST", handler: useTemplate.POST, model: "taskTemplate" },
  { path: "saved-views", method: "GET", handler: savedViews.GET, model: "savedView" },
  { path: "saved-views", method: "PATCH", handler: savedViews.PATCH, model: "savedView" },
  { path: "saved-views", method: "DELETE", handler: savedViews.DELETE, model: "savedView" },
  { path: "automation-rules", method: "GET", handler: automationRules.GET, model: "automationRule" },
  { path: "automation-rules", method: "PATCH", handler: automationRules.PATCH, model: "automationRule" },
  { path: "automation-rules", method: "DELETE", handler: automationRules.DELETE, model: "automationRule" },
  { path: "recurring-tasks", method: "GET", handler: recurringTasks.GET, model: "recurringTask" },
  { path: "recurring-tasks", method: "PATCH", handler: recurringTasks.PATCH, model: "recurringTask" },
  { path: "recurring-tasks", method: "DELETE", handler: recurringTasks.DELETE, model: "recurringTask" },
  { path: "project-templates", method: "DELETE", handler: projectTemplates.DELETE, model: "projectTemplate" },
  { path: "project-templates/use", method: "POST", handler: useProjectTemplate.POST, model: "projectTemplate" },
  { path: "notifications", method: "PATCH", handler: notifications.PATCH, model: "notification" },
] as const;

function request(method: string) {
  return new NextRequest("http://localhost/api/resource/resource-42", {
    method,
    ...(method === "PATCH" || method === "POST"
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Updated", projectName: "New project", isDefault: true }) }
      : {}),
  });
}

function assertNoWrites() {
  for (const key of ["taskTemplate", "automationRule", "recurringTask", "savedView", "projectTemplate", "notification"] as const) {
    expect(mocks.prisma[key].update).not.toHaveBeenCalled();
    expect(mocks.prisma[key].delete).not.toHaveBeenCalled();
    expect(mocks.prisma[key].updateMany).not.toHaveBeenCalled();
  }
  expect(mocks.txRecurringTask.update).not.toHaveBeenCalled();
  expect(mocks.prisma.project.create).not.toHaveBeenCalled();
  expect(mocks.prisma.projectColumn.findFirst).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.requireApiUser.mockResolvedValue({ id: "user-1", globalRole: "USER" });
  mocks.getServerSession.mockResolvedValue({ user: { id: "user-1", email: "user-1@example.test" } });
  // Saved-view routes refresh the cookie identity and current project access.
  mocks.prisma.user.findUnique.mockResolvedValue({ id: "user-1", email: "user-1@example.test", globalRole: "USER" });
  mocks.prisma.project.findUnique.mockResolvedValue({ id: "project-1", ownerId: "user-1", members: [] });
  mocks.prisma.project.create.mockResolvedValue({ id: "new-project", name: "New project" });
  mocks.prisma.projectColumn.findFirst.mockResolvedValue(null);
  mocks.raw.mockResolvedValue([{ id: "project-1" }]);
  // Account revocation is read via SQL, independently of the user identity lookup.
  mocks.accountStatus.mockResolvedValue([{ blocked: false }]);
  mocks.prisma.task.findFirst.mockResolvedValue({ id: "task-1" });
  mocks.transaction.mockImplementation(async (operation) => operation({ $queryRaw: mocks.raw, recurringTask: mocks.txRecurringTask }));
});

describe.each(cases)("$method $path with promised params", ({ handler, method, model, path }) => {
  function fixture(ownerId = "user-1") {
    return {
      id: "resource-42", name: "Existing", createdById: ownerId, userId: ownerId,
      // Task-scoped visibility requires both target IDs in metadata.
      type: "task_assigned", metadata: { visibility: "PUBLIC", taskId: "task-1", projectId: "project-1" },
      projectId: "project-1", project: { id: "project-1", ownerId, members: [] },
      templateData: { columns: [], tags: [] }, nextRunAt: new Date("2026-10-01"),
    };
  }

  it("looks up the resolved id and uses the same id for writes", async () => {
    if (path === "project-templates/use") {
      mocks.requireApiUser.mockResolvedValue({ id: "user-1", globalRole: "ADMIN" });
    }
    const db = path === "recurring-tasks" && method === "PATCH" ? mocks.txRecurringTask : mocks.prisma[model];
    db.findUnique.mockResolvedValue(fixture());
    // Notification reads go through markNotificationRead, which re-checks the row by id+userId.
    db.findFirst.mockResolvedValue(fixture());
    db.update.mockResolvedValue({ id: "resource-42", name: "Updated" });
    db.delete.mockResolvedValue(fixture());
    const response = await handler(request(method), { params: Promise.resolve({ id: "resource-42" }) });

    expect(db.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "resource-42" } }));
    // Task-template use intentionally stops at its real "no columns" validation.
    expect(response.status).toBe(path === "templates/use" ? 400 : path === "project-templates/use" ? 201 : 200);
    if (method === "PATCH") {
      if (path === "notifications") {
        expect(db.findFirst).toHaveBeenCalledWith({ where: { id: "resource-42", userId: "user-1" } });
        expect(mocks.accountStatus).toHaveBeenCalledTimes(1);
        expect(mocks.prisma.task.findFirst).toHaveBeenCalledWith({
          where: { AND: [
            taskReadPredicate({ id: "user-1", globalRole: "USER" }, [], [], true),
            { id: "task-1", projectId: "project-1" },
          ] },
          select: { id: true },
        });
        expect(db.update).toHaveBeenCalledWith({
          where: { id: "resource-42", userId: "user-1" },
          data: { read: true, readAt: expect.any(Date) },
        });
      } else {
        expect(db.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "resource-42" } }));
      }
      expect(await response.json()).toMatchObject({ data: { id: "resource-42" } });
    }
    if (method === "DELETE") expect(db.delete).toHaveBeenCalledWith({ where: { id: "resource-42" } });
    if (path === "saved-views" && method === "PATCH") {
      expect(db.updateMany).toHaveBeenCalledWith({
        where: { projectId: "project-1", createdById: "user-1", isDefault: true, id: { not: "resource-42" } },
        data: { isDefault: false },
      });
    }
  });

  it("returns 401 before resolving params or accessing data for an unauthenticated request", async () => {
    mocks.requireApiUser.mockRejectedValue(new UnauthorizedError());
    mocks.getServerSession.mockResolvedValue(null);
    const response = await handler(request(method), { params: new Promise<{ id: string }>(() => {}) });
    expect(response.status).toBe(401);
    expect(mocks.prisma[model].findUnique).not.toHaveBeenCalled();
    assertNoWrites();
  });

  it("retains foreign-owner denial and never writes", async () => {
    const db = path === "recurring-tasks" && method === "PATCH" ? mocks.txRecurringTask : mocks.prisma[model];
    db.findUnique.mockResolvedValue(fixture("other-user"));
    const response = await handler(request(method), { params: Promise.resolve({ id: "resource-42" }) });
    expect(response.status).toBe(403);
    if (path === "project-templates/use") expect(db.findUnique).not.toHaveBeenCalled();
    else expect(db.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "resource-42" } }));
    assertNoWrites();
  });
});
