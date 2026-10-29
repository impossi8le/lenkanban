import { describe, expect, it, vi } from "vitest";

import {
  canActorReadInternal,
  isTaskWatcher,
  loadInternalMessageIds,
  loadProjectDiscussionFacts,
  loadWatcherIds,
  markMessageInternal,
  resolveInternalReaderIds,
  type DiscussionDb,
  type ProjectDiscussionFacts,
} from "./discussion-access";

type Row = Record<string, unknown>;
const db = (overrides: Row = {}) => ({
  project: { findUnique: vi.fn(async () => null) },
  user: { findMany: vi.fn(async () => []) },
  scopedPrivilegeAssignment: { findMany: vi.fn(async () => []) },
  $queryRaw: vi.fn(async () => []),
  $executeRaw: vi.fn(async () => 1),
  ...overrides,
}) as unknown as DiscussionDb;

const activeFacts: ProjectDiscussionFacts = {
  projectId: "project",
  departmentId: "dept",
  departmentLeaderId: "leader",
  departmentActive: true,
  groupId: "group",
  groupActive: true,
  groupMemberIds: ["author", "member"],
};

describe("project discussion facts", () => {
  it("keeps active department and group links", async () => {
    const database = db({
      project: {
        findUnique: vi.fn(async () => ({
          id: "project",
          departmentId: "dept",
          responsibleGroupId: "group",
          department: { id: "dept", leaderId: "leader", archivedAt: null },
          responsibleGroup: {
            id: "group",
            archivedAt: null,
            members: [{ userId: "member" }, { userId: "author" }, { userId: "member" }],
          },
        })),
      },
    });
    await expect(loadProjectDiscussionFacts(database, "project")).resolves.toEqual(activeFacts);
  });

  it("drops archived group membership and leadership", async () => {
    const database = db({
      project: {
        findUnique: vi.fn(async () => ({
          id: "project",
          departmentId: "dept",
          responsibleGroupId: "group",
          department: { id: "dept", leaderId: "leader", archivedAt: new Date() },
          responsibleGroup: {
            id: "group",
            archivedAt: new Date(),
            members: [{ userId: "member" }],
          },
        })),
      },
    });
    await expect(loadProjectDiscussionFacts(database, "project")).resolves.toEqual({
      projectId: "project",
      departmentId: "dept",
      departmentLeaderId: null,
      departmentActive: false,
      groupId: "group",
      groupActive: false,
      groupMemberIds: [],
    });
  });

  it("returns null when the board is missing or the read fails", async () => {
    await expect(loadProjectDiscussionFacts(db(), "project")).resolves.toBeNull();
    const failing = db({ project: { findUnique: vi.fn(async () => { throw new Error("offline"); }) } });
    await expect(loadProjectDiscussionFacts(failing, "project")).resolves.toBeNull();
  });
});

describe("internal reader resolution", () => {
  it("includes active group members, the configured leader and global administrators", async () => {
    const database = db({ user: { findMany: vi.fn(async () => [{ id: "admin" }]) } });
    const readers = await resolveInternalReaderIds(
      database,
      activeFacts,
      ["member", "author", "leader", "admin", "outsider"],
    );
    expect([...readers].sort()).toEqual(["admin", "author", "leader", "member"]);
  });

  it("adds department and board administrators from explicit scoped grants", async () => {
    const database = db({
      scopedPrivilegeAssignment: {
        findMany: vi.fn(async () => [
          {
            id: "dept-grant", userId: "dept-admin", profileId: "p1", scopeKind: "department",
            departmentId: "dept", projectId: null,
            profile: { id: "p1", permissions: ["request.internal.read", "request.read"], archivedAt: null },
          },
          {
            id: "board-grant", userId: "board-admin", profileId: "p2", scopeKind: "board",
            departmentId: null, projectId: "project",
            profile: { id: "p2", permissions: ["request.internal.read", "request.read"], archivedAt: null },
          },
          {
            id: "org-grant", userId: "org-admin", profileId: "p3", scopeKind: "organization",
            departmentId: null, projectId: null,
            profile: { id: "p3", permissions: ["request.internal.read", "request.read"], archivedAt: null },
          },
        ]),
      },
    });
    const readers = await resolveInternalReaderIds(
      database,
      { ...activeFacts, groupMemberIds: [], departmentLeaderId: null },
      ["dept-admin", "board-admin", "org-admin"],
    );
    expect([...readers].sort()).toEqual(["board-admin", "dept-admin", "org-admin"]);
  });

  it("rejects wrong-scope, archived, read-only and malformed grants", async () => {
    const database = db({
      scopedPrivilegeAssignment: {
        findMany: vi.fn(async () => [
          {
            id: "other-dept", userId: "other-dept-admin", profileId: "p1", scopeKind: "department",
            departmentId: "other", projectId: null,
            profile: { id: "p1", permissions: ["request.internal.read", "request.read"], archivedAt: null },
          },
          {
            id: "other-board", userId: "other-board-admin", profileId: "p2", scopeKind: "board",
            departmentId: null, projectId: "other-project",
            profile: { id: "p2", permissions: ["request.internal.read", "request.read"], archivedAt: null },
          },
          {
            id: "archived", userId: "archived-admin", profileId: "p3", scopeKind: "organization",
            departmentId: null, projectId: null,
            profile: { id: "p3", permissions: ["request.internal.read", "request.read"], archivedAt: new Date() },
          },
          {
            id: "read-only", userId: "reader", profileId: "p4", scopeKind: "organization",
            departmentId: null, projectId: null,
            profile: { id: "p4", permissions: ["request.read"], archivedAt: null },
          },
          {
            id: "internal-only", userId: "internal-only", profileId: "p5", scopeKind: "organization",
            departmentId: null, projectId: null,
            profile: { id: "p5", permissions: ["request.internal.read"], archivedAt: null },
          },
          {
            id: "malformed", userId: "malformed", profileId: "p6", scopeKind: "organization",
            departmentId: null, projectId: null,
            profile: { id: "p6", permissions: ["request.internal.read", "admin.all"], archivedAt: null },
          },
        ]),
      },
    });
    const readers = await resolveInternalReaderIds(
      database,
      { ...activeFacts, groupMemberIds: [], departmentLeaderId: null },
      ["other-dept-admin", "other-board-admin", "archived-admin", "reader", "internal-only", "malformed"],
    );
    expect([...readers]).toEqual([]);
  });

  it("keeps confirmed readers when an auxiliary lookup fails", async () => {
    const database = db({
      user: { findMany: vi.fn(async () => { throw new Error("offline"); }) },
      scopedPrivilegeAssignment: { findMany: vi.fn(async () => { throw new Error("offline"); }) },
    });
    const readers = await resolveInternalReaderIds(database, activeFacts, ["member", "leader", "outsider"]);
    expect([...readers].sort()).toEqual(["leader", "member"]);
  });

  it("resolves the current actor on the server", async () => {
    await expect(canActorReadInternal(db(), { id: "outsider", globalRole: "USER" }, activeFacts))
      .resolves.toBe(false);
    await expect(canActorReadInternal(db(), { id: "member", globalRole: "USER" }, activeFacts))
      .resolves.toBe(true);
    await expect(canActorReadInternal(db(), { id: "outsider", globalRole: "ADMIN" }, activeFacts))
      .resolves.toBe(true);
    await expect(canActorReadInternal(db(), { id: "outsider", globalRole: "ADMIN" }, null))
      .resolves.toBe(true);
    await expect(canActorReadInternal(db(), { id: "outsider", globalRole: "USER" }, null))
      .resolves.toBe(false);
  });
});

describe("internal message storage", () => {
  it("returns the internal ids of the task", async () => {
    const database = db({
      $queryRaw: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
        expect(parts.join("?")).toContain('"isInternal" = true');
        expect(values).toEqual(["task"]);
        return [{ id: "internal-1" }, { id: "internal-2" }];
      }),
    });
    const ids = await loadInternalMessageIds(database, "task");
    expect(ids).toEqual(new Set(["internal-1", "internal-2"]));
  });

  it("treats a missing isInternal column as legacy public-only storage", async () => {
    const missing = Object.assign(new Error("Raw query failed"), { code: "P2010", meta: { code: "42703" } });
    const database = db({ $queryRaw: vi.fn(async () => { throw missing; }) });
    await expect(loadInternalMessageIds(database, "task")).resolves.toBeNull();

    const text = new Error('column "isInternal" does not exist');
    const byMessage = db({ $queryRaw: vi.fn(async () => { throw text; }) });
    await expect(loadInternalMessageIds(byMessage, "task")).resolves.toBeNull();
  });

  it("does not hide internal rows when storage fails for another reason", async () => {
    const database = db({ $queryRaw: vi.fn(async () => { throw new Error("connection reset"); }) });
    await expect(loadInternalMessageIds(database, "task")).rejects.toThrow("connection reset");
  });

  it("persists the internal flag and fails when no row is updated", async () => {
    const database = db({
      $executeRaw: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
        expect(parts.join("?")).toContain('SET "isInternal" = true');
        expect(values).toEqual(["message"]);
        return 1;
      }),
    });
    await expect(markMessageInternal(database, "message")).resolves.toBeUndefined();

    const missing = db({ $executeRaw: vi.fn(async () => 0) });
    await expect(markMessageInternal(missing, "message")).rejects.toThrow("INTERNAL_VISIBILITY_NOT_PERSISTED");
  });
});

describe("watchers", () => {
  it("returns unique sorted watcher ids", async () => {
    const database = db({ $queryRaw: vi.fn(async () => [{ userId: "b" }, { userId: "a" }, { userId: "b" }]) });
    await expect(loadWatcherIds(database, "task")).resolves.toEqual(["a", "b"]);
  });

  it("reports a watcher only for the exact task", async () => {
    const database = db({
      $queryRaw: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
        expect(parts.join("?")).toContain('"userId" = ?');
        expect(values).toEqual(["task", "user"]);
        return [{ userId: "user" }];
      }),
    });
    await expect(isTaskWatcher(database, "task", "user")).resolves.toBe(true);
  });

  it("denies watcher access when storage is unavailable", async () => {
    const database = db({ $queryRaw: vi.fn(async () => { throw new Error("missing table"); }) });
    await expect(loadWatcherIds(database, "task")).resolves.toEqual([]);
    await expect(isTaskWatcher(database, "task", "user")).resolves.toBe(false);
  });
});


it("reads internal discussion through a multi-permission group role and immediately revokes it", async () => {
  const findMany = vi.fn(async () => [{ id: "group-grant", groupId: "other-group", profileId: "executor", scopeKind: "department", departmentId: "dept", projectId: null,
    profile: { id: "executor", archivedAt: null, permissions: ["request.execute", "request.internal.read", "request.read"] },
    group: { archivedAt: null, members: [{ userId: "scoped-executor" }] } }]);
  const database = db({ groupPrivilegeAssignment: { findMany } });
  const actor = { id: "scoped-executor", globalRole: "USER" as const };
  expect(await canActorReadInternal(database, actor, activeFacts)).toBe(true);
  findMany.mockResolvedValue([]);
  expect(await canActorReadInternal(database, actor, activeFacts)).toBe(false);
});
