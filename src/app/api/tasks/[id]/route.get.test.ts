import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/request-queue-unseen", () => ({ readRequestQueueArrivalMap: async (_db: unknown, _actor: string, ids: string[]) => new Map(ids.map(id => [id, null])) }));

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  taskFindFirst: vi.fn(),
  boards: vi.fn(),
  relationship: "author",
  projectFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {
  task: { findFirst: mocks.taskFindFirst },
  project: { findUnique: mocks.projectFindUnique, findMany: mocks.boards },
} }));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: mocks.requireApiUser,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock("@/lib/notification-triggers", () => ({}));
vi.mock("@/lib/automation-processor", () => ({}));
vi.mock("@/socket/board-events", () => ({}));

import * as route from "./route";
import { UnauthorizedError } from "@/lib/require-api-user";

type Row = { [key: string]: unknown };
function matches(row: unknown, where: unknown): boolean {
  if (where === null || typeof where !== "object") return row === where;
  const source = row as Row | null;
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every(item => matches(row, item));
    if (key === "OR") return (value as unknown[]).some(item => matches(row, item));
    if (key === "is") return value === null ? row === null : row !== null && matches(row, value);
    if (key === "some") return Array.isArray(row) && row.some(item => matches(item, value));
    if (key === "none") return Array.isArray(row) && !row.some(item => matches(item, value));
    if (key === "not") return !matches(row, value);
    if (key === "in") return (value as unknown[]).includes(row);
    if (key === "notIn") return !(value as unknown[]).includes(row);
    if (key === "contains") return typeof row === "string" && row.toLowerCase().includes(String(value).toLowerCase());
    if (key === "mode") return true;
    if (!source || typeof source !== "object" || !(key in source)) throw new Error(`Unsupported query field: ${key}`);
    return matches(source[key], value);
  });
}

async function readTask(id = "task-1") {
  return route.GET(new Request(`http://localhost/api/tasks/${id}`), {
    params: Promise.resolve({ id }),
  });
}

describe("GET task metadata for unread messages", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireApiUser.mockResolvedValue({ id: "reader", globalRole: "USER" });
    mocks.relationship = "author";
    mocks.boards.mockResolvedValue([{ id: "project-1" }]);
    mocks.taskFindFirst.mockImplementation(async ({ where, select }) => {
      const record = { id: "task-1", title: "Review artwork", projectId: "project-1",
        request: null, createdById: mocks.relationship === "author" ? "reader" : "other",
        assignees: mocks.relationship === "executor" ? [{ userId: "reader" }] : [],
        watchers: mocks.relationship === "watcher" ? [{ userId: "reader" }] : [],
        project: { name: "Design", departmentId: null, department: null, responsibleGroup: null } };
      if (!matches(record, where)) return null;
      return Object.fromEntries(Object.entries(record).filter(([key]) => select[key]).map(([key, value]) =>
        [key, key === "project" && !select.project?.select?.name ? {} : value]));
    });
    mocks.projectFindUnique.mockResolvedValue({
      id: "project-1", ownerId: "owner", members: [{ role: "MEMBER" }],
    });
  });

  it.each(["author", "executor", "watcher", "admin"])("returns the Messages contract for a permitted %s", async (role) => {
    mocks.relationship = role;
    if (role === "admin") {
      mocks.requireApiUser.mockResolvedValue({ id: "reader", globalRole: "ADMIN" });
      mocks.projectFindUnique.mockResolvedValue(null);
    }
    const response = await readTask();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: {
      id: "task-1", title: "Review artwork", projectId: "project-1", project: { name: "Design" },
    } });
    expect(mocks.taskFindFirst).toHaveBeenCalledOnce();
    expect(mocks.projectFindUnique).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated reader", async () => {
    mocks.requireApiUser.mockRejectedValue(new UnauthorizedError());
    const response = await readTask();
    expect(response.status).toBe(401);
  });

  it("does not expose another task through project membership alone", async () => {
    mocks.projectFindUnique.mockResolvedValue({ id: "project-1", ownerId: "owner", members: [] });
    mocks.relationship = "none";
    const response = await readTask();
    expect(response.status).toBe(404);
    expect(await response.json()).not.toHaveProperty("data");
  });

  it("returns not found for a missing task", async () => {
    const response = await readTask("missing");
    expect(response.status).toBe(404);
  });
});
