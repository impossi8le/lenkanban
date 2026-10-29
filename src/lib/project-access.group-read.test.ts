import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
const mocks = vi.hoisted(() => ({ project: vi.fn(), task: vi.fn(), boards: vi.fn(), grants: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  project: { findUnique: mocks.project, findMany: mocks.boards },
  task: { findFirst: mocks.task }, scopedPrivilegeAssignment: { findMany: mocks.grants },
} }));
import { getProjectAccess, getTaskReadWhere, requireTaskRead, requireTaskWrite } from "./project-access";
import { NotFoundError } from "./errors";

const actor = { id: "group-reader", globalRole: "USER" as const };
function board(group: unknown = { archivedAt: null, members: [{ userId: actor.id }] }) {
  return { id: "board", departmentId: null, department: null, ownerId: "other", members: [], responsibleGroup: group };
}
function matches(row: unknown, where: unknown): boolean {
  if (where === null || typeof where !== "object") return row === where;
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every(item => matches(row, item));
    if (key === "OR") return (value as unknown[]).some(item => matches(row, item));
    if (key === "has") return Array.isArray(row) && row.includes(value);
    if (key === "isEmpty") return Array.isArray(row) && (row.length === 0) === value;
    if (key === "is") return value === null ? row === null : row !== null && matches(row, value);
    if (key === "some") return Array.isArray(row) && row.some(item => matches(item, value));
    if (key === "none") return Array.isArray(row) && !row.some(item => matches(item, value));
    if (key === "not") return !matches(row, value);
    if (key === "in") return (value as unknown[]).includes(row);
    if (row === null || typeof row !== "object" || !(key in row)) throw new Error(`Unsupported predicate: ${key}`);
    return matches((row as Record<string, unknown>)[key], value);
  });
}
beforeEach(() => {
  vi.resetAllMocks();vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "");
  mocks.project.mockResolvedValue(board());mocks.boards.mockResolvedValue([{ id: "board" }]);mocks.grants.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("explicit active responsible group grants board read, never legacy write/manage", () => {
  it("reads a group-only board with the unchanged minimal DTO and no legacy membership", async () => {
    expect(await getProjectAccess(actor, "board")).toEqual({ projectId: "board", canRead: true, canWrite: false, canManageMembers: false });
  });
  it.each([null, { archivedAt: new Date(0), members: [{ userId: actor.id }] }, { archivedAt: null, members: [] }, { archivedAt: null, members: [{ userId: "other" }] }])("rejects null, archived or nonmatching group %#", async group => {
    mocks.project.mockResolvedValue(board(group));
    expect(await getProjectAccess(actor, "board")).toEqual({ projectId: "board", canRead: false, canWrite: false, canManageMembers: false });
  });
  it("rechecks group membership on every call and never stores a cached grant", async () => {
    expect((await getProjectAccess(actor, "board")).canRead).toBe(true);
    mocks.project.mockResolvedValue(board(null));
    expect((await getProjectAccess(actor, "board")).canRead).toBe(false);
    expect(mocks.project).toHaveBeenCalledTimes(2);
  });
  it("preserves independent legacy member and project administrator rights", async () => {
    mocks.project.mockResolvedValue({ ...board(), members: [{ role: "MEMBER" }] });
    expect(await getProjectAccess(actor, "board")).toEqual({ projectId: "board", canRead: true, canWrite: true, canManageMembers: false });
    mocks.project.mockResolvedValue({ ...board(), members: [{ role: "PROJECT_ADMIN" }] });
    expect((await getProjectAccess(actor, "board")).canManageMembers).toBe(true);
  });
  it("uses an injected transaction and bounded persisted group membership facts", async () => {
    const project = vi.fn().mockResolvedValue(board());
    const tx = { project: { findUnique: project } } as unknown as Pick<Prisma.TransactionClient, "project" | "user">;
    expect((await getProjectAccess(actor, "board", tx)).canRead).toBe(true);
    expect(mocks.project).not.toHaveBeenCalled();
    expect(project.mock.calls[0][0].select.responsibleGroup).toEqual({ select: { archivedAt: true, members: { where: { userId: actor.id }, select: { userId: true }, take: 1 } } });
  });
  it("group-only board discovery never reads another request or grants mutation", async () => {
    let record = { id: "task", projectId: "board", project: board(), createdById: "other", assignees: [], watchers: [],
      request: { contractVersion: 1, state: "SUBMITTED", deletedAt: null, authorId: "other", executorId: null as string | null, audienceUserIds: [] as string[] } };
    mocks.task.mockImplementation(async ({ where }: { where: unknown }) => matches(record, where) ? { id: "task", projectId: "board" } : null);
    await expect(requireTaskRead(actor, "task")).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireTaskWrite(actor, "task", "board")).rejects.toBeInstanceOf(NotFoundError);
    record = { ...record, request: { ...record.request, state: "IN_PROGRESS", executorId: "colleague" } };
    await expect(requireTaskRead(actor, "task")).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireTaskWrite(actor, "task", "board")).rejects.toBeInstanceOf(NotFoundError);
    record = { ...record, request: { ...record.request, state: "DRAFT", executorId: null } };
    expect(matches(record, await getTaskReadWhere(actor))).toBe(false);
    await expect(requireTaskRead(actor, "task")).rejects.toBeInstanceOf(NotFoundError);
  });
});
