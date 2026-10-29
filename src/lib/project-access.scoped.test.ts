import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { getTaskReadWhere } from "./project-access";

// Independent fixture evaluator, not PostgreSQL evidence. Unknown operators fail.
type Row = Record<string, unknown>;
function matches(row: unknown, where: unknown): boolean {
  if (where === null || typeof where !== "object") return row === where;
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every(part => matches(row, part));
    if (key === "OR") return (value as unknown[]).some(part => matches(row, part));
    if (key === "has") return Array.isArray(row) && row.includes(value);
    if (key === "isEmpty") return Array.isArray(row) && (row.length === 0) === value;
    if (key === "is") return value === null ? row === null : row !== null && matches(row, value);
    if (key === "some") return Array.isArray(row) && row.some(item => matches(item, value));
    if (key === "none") return Array.isArray(row) && !row.some(item => matches(item, value));
    if (key === "not") return !matches(row, value);
    if (key === "in") return (value as unknown[]).includes(row);
    if (key === "notIn") return !(value as unknown[]).includes(row);
    if (!row || typeof row !== "object" || !(key in row)) throw new Error(`Unsupported fixture field ${key}`);
    return matches((row as Row)[key], value);
  });
}
const actor = { id: "reader", globalRole: "USER" as const };
const canonical = { contractVersion: 1, state: "SUBMITTED", authorId: "other", executorId: null, deletedAt: null, audienceUserIds: [] as string[] };
const project = { id: "board", ownerId: "owner", members: [], departmentId: "dept",
  department: { employees: [{ id: actor.id, isBlocked: false, blockedAt: null }], archivedAt: null, leaderId: null }, responsibleGroup: { leaderId: null, archivedAt: null, members: [] } };
function task(overrides: Row = {}): Row {
  return { projectId: "board", createdById: "other", request: null, assignees: [], watchers: [], project, ...overrides };
}
function fixture(ids = ["board", "other-board"]) {
  const boards = vi.fn(async (input: { where?: { id: string } }) => ids
    .filter(id => !input.where || id === input.where.id).map(id => ({ id })));
  const grants = vi.fn(async () => [] as Row[]);
  const groupGrants = vi.fn(async () => [] as Row[]);
  const database = { groupPrivilegeAssignment: { findMany: groupGrants }, project: { findMany: boards }, scopedPrivilegeAssignment: { findMany: grants } } as unknown as Parameters<typeof getTaskReadWhere>[2];
  return { boards, grants, groupGrants, database };
}
beforeEach(() => vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", ""));
afterEach(() => vi.unstubAllEnvs());

describe("single-board read snapshot narrowing", () => {
  it("applies a reusable role through an active group and refreshes its revocation", async () => {
    const f = fixture();
    f.groupGrants.mockResolvedValue([{ id: "group-grant", groupId: "group", profileId: "profile", scopeKind: "department", departmentId: "dept", projectId: null,
      profile: { id: "profile", archivedAt: null, permissions: ["request.execute", "request.internal.read", "request.read"] },
      group: { archivedAt: null, members: [{ userId: actor.id }] } }]);
    expect(matches(task({ request: canonical }), await getTaskReadWhere(actor, {}, f.database, { projectId: "board" }))).toBe(true);
    expect(matches(task({ request: { ...canonical, state: "DRAFT" } }), await getTaskReadWhere(actor, {}, f.database, { projectId: "board" }))).toBe(false);
    f.groupGrants.mockResolvedValue([]);
    expect(matches(task({ request: canonical }), await getTaskReadWhere(actor, {}, f.database, { projectId: "board" }))).toBe(false);
    f.grants.mockResolvedValue([{ id: "personal", userId: actor.id, profileId: "read", scopeKind: "board", departmentId: null, projectId: "board", profile: { archivedAt: null, permissions: ["request.execute"] } }]);
    expect(matches(task({ request: canonical }), await getTaskReadWhere(actor, {}, f.database, { projectId: "board" }))).toBe(true);
  });

  it.each([
    ["legacy author", task({ createdById: actor.id }), true],
    ["single assignee", task({ assignees: [{ userId: actor.id }] }), true],
    ["ambiguous assignee", task({ assignees: [{ userId: actor.id }, { userId: "other" }] }), false],
    ["legacy board owner", task({ project: { ...project, ownerId: actor.id } }), false],
    ["legacy board member", task({ project: { ...project, members: [{ userId: actor.id }] } }), false],
    ["canonical author", task({ request: { ...canonical, authorId: actor.id } }), true],
    ["canonical executor", task({ request: { ...canonical, state: "IN_PROGRESS", executorId: actor.id } }), true],
    ["canonical watcher", task({ request: canonical, watchers: [{ userId: actor.id }] }), true],
    ["group membership alone", task({ request: canonical, project: { ...project, departmentId: null, department: null, responsibleGroup: { leaderId: null, archivedAt: null, members: [{ userId: actor.id }] } } }), false],
    ["archived group", task({ project: { ...project, responsibleGroup: { leaderId: null, archivedAt: new Date(0), members: [{ userId: actor.id }] } } }), false],
    ["own draft", task({ request: { ...canonical, state: "DRAFT", authorId: actor.id } }), true],
    ["foreign draft watcher", task({ request: { ...canonical, state: "DRAFT" }, watchers: [{ userId: actor.id }] }), false],
    ["deleted author", task({ request: { ...canonical, authorId: actor.id, deletedAt: new Date(0) } }), false],
    ["foreign row", task(), false],
  ] as const)("preserves %s and never admits another board", async (_label, record, allowed) => {
    const f = fixture();
    const old = await getTaskReadWhere(actor, {}, f.database);
    const bounded = await getTaskReadWhere(actor, {}, f.database, { projectId: "board" });
    expect(matches(record, bounded)).toBe(allowed);
    expect(matches(record, bounded)).toBe(matches(record, { AND: [old, { projectId: "board" }] }));
    expect(matches({ ...record, projectId: "other-board" }, bounded)).toBe(false);
    expect(f.boards).toHaveBeenLastCalledWith({ where: { id: "board" }, select: { id: true } });
  });

  it.each([
    ["organization", null, null, true], ["board", "board", null, true],
    ["board", "other-board", null, false], ["department", null, "dept", true],
    ["department", null, "other-dept", false], ["unknown", null, null, false],
  ] as const)("preserves fresh %s/%s/%s grant scope", async (scopeKind, projectId, departmentId, allowed) => {
    const f = fixture();
    f.grants.mockResolvedValue([{ id: "grant", userId: actor.id, profileId: "profile", scopeKind, projectId, departmentId, profile: { archivedAt: null, permissions: ["request.execute"] } }]);
    const old = await getTaskReadWhere(actor, {}, f.database);
    const bounded = await getTaskReadWhere(actor, {}, f.database, { projectId: "board" });
    expect(matches(task({ request: canonical }), bounded)).toBe(allowed);
    expect(matches(task(), bounded)).toBe(matches(task(), old));
    expect(matches(task({ request: { ...canonical, state: "DRAFT" } }), bounded)).toBe(false);
    f.grants.mockResolvedValue([]);
    expect(matches(task(), await getTaskReadWhere(actor, {}, f.database, { projectId: "board" }))).toBe(false);
    expect(f.grants).toHaveBeenCalledTimes(3);
  });

  it("bounds ADMIN only when explicitly requested, retaining its bypass", async () => {
    const f = fixture(); const admin = { ...actor, globalRole: "ADMIN" as const };
    const filter = { id: "task" };
    expect(await getTaskReadWhere(admin, filter, f.database)).toBe(filter);
    const bounded = await getTaskReadWhere(admin, {}, f.database, { projectId: "board" });
    expect(matches(task(), bounded)).toBe(true);
    expect(matches(task({ projectId: "other-board" }), bounded)).toBe(false);
    expect(f.boards).not.toHaveBeenCalled(); expect(f.grants).not.toHaveBeenCalled();
  });

  it("preserves empty/deleted snapshot denial, configured intersection and concurrent new-board exclusion", async () => {
    const f = fixture([]);
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "other-board");
    expect(matches(task({ createdById: actor.id }), await getTaskReadWhere(actor, {}, f.database, { projectId: "board" }))).toBe(false);
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "board,other-board");
    const scoped = await getTaskReadWhere(actor, {}, f.database, { projectId: "board" });
    const old = await getTaskReadWhere(actor, {}, f.database);
    expect(matches(task({ createdById: actor.id }), scoped)).toBe(matches(task({ createdById: actor.id }), old));
    expect(JSON.stringify(scoped)).not.toContain("other-board");
    expect(matches(task({ createdById: actor.id, projectId: "new-board" }), scoped)).toBe(false);
  });

  it("ANDs contradictory filters rather than replacing them", async () => {
    const f = fixture();
    const bounded = await getTaskReadWhere(actor, { projectId: "other-board" }, f.database, { projectId: "board" });
    for (const projectId of ["board", "other-board"]) expect(matches(task({ projectId, createdById: actor.id }), bounded)).toBe(false);
  });

  it.each(["boards", "grants"] as const)("propagates %s failure instead of widening access", async delegate => {
    const f = fixture(); f[delegate].mockRejectedValue(new Error("synthetic-storage-failure"));
    await expect(getTaskReadWhere(actor, {}, f.database, { projectId: "board" })).rejects.toThrow("synthetic-storage-failure");
  });

  it("leaves the unscoped persisted-board query unchanged", async () => {
    const f = fixture(); await getTaskReadWhere(actor, {} as Prisma.TaskWhereInput, f.database);
    expect(f.boards).toHaveBeenCalledExactlyOnceWith({ select: { id: true } });
  });

  it("keeps the snapshot and predicate bounded with 1000 unrelated boards", async () => {
    const f = fixture(["board", ...Array.from({ length: 1000 }, (_, index) => `unrelated-${index}`)]);
    const global = await getTaskReadWhere(actor, {}, f.database);
    const bounded = await getTaskReadWhere(actor, {}, f.database, { projectId: "board" });
    expect(await f.boards.mock.results[0].value).toHaveLength(1001);
    expect(await f.boards.mock.results[1].value).toHaveLength(1);
    expect(JSON.stringify(global)).toContain("unrelated-999");
    expect(JSON.stringify(bounded)).not.toContain("unrelated-");
    expect(matches(task({ createdById: actor.id }), bounded)).toBe(true);
  });
});
