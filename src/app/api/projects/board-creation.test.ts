import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), quota: vi.fn(), log: vi.fn(),
  create: vi.fn(), findMany: vi.fn(), template: vi.fn(),
  department: vi.fn(), user: vi.fn(), group: vi.fn(),
  transaction: vi.fn(), query: vi.fn(), receiptFind: vi.fn(), receiptCreate: vi.fn(),
  state: vi.fn(), stateUpdate: vi.fn(), update: vi.fn(), read: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  $transaction: mocks.transaction, $queryRaw: mocks.query,
  organizationOperation: { findUnique: mocks.receiptFind, create: mocks.receiptCreate },
  organizationState: { findUnique: mocks.state, upsert: mocks.state, update: mocks.stateUpdate },
  project: { create: mocks.create, findMany: mocks.findMany, update: mocks.update, findUniqueOrThrow: mocks.read },
  projectTemplate: { findUnique: mocks.template },
  department: { findUnique: mocks.department },
  user: { findUnique: mocks.user },
  responsibleGroup: { findUnique: mocks.group },
} }));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: mocks.auth,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/rate-limit")>(), rateLimitOrThrowKey: mocks.quota,
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: mocks.log } }));
vi.mock("@/lib/nextauth", () => ({ nextAuthOptions: {} }));
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));

import { UnauthorizedError } from "@/lib/require-api-user";
import { POST as createProject } from "./route";
import { POST as applyTemplate } from "../project-templates/[id]/use/route";
import { DEFAULT_BOARD_COLUMNS } from "./board-creation";
import { prisma } from "@/lib/prisma";

const params = () => ({ params: Promise.resolve({ id: "template-1" }) });
function request(body: unknown) {
  return new Request("http://localhost/api/projects", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
const defaultColumns = [
  { name: "Новые", color: "#d92d3a", position: 0, workflowKey: "TODO" },
  { name: "В работе", color: "#246ed1", position: 1, workflowKey: "IN_PROGRESS" },
  { name: "Ждём сотрудника", color: "#d69a20", position: 2, workflowKey: "NEEDS_INFO" },
  { name: "Решено", color: "#168454", position: 3, workflowKey: "REVIEW" },
  { name: "Закрыто", color: "#168454", position: 4, workflowKey: "DONE" },
];
const include = { columns: { orderBy: { position: "asc" } }, tags: true };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ id: "admin-1", globalRole: "ADMIN" });
  mocks.quota.mockResolvedValue(undefined);
  mocks.transaction.mockImplementation(async run => run(prisma));
  mocks.state.mockResolvedValue({ version: 0 });
  mocks.receiptFind.mockResolvedValue(null);
  mocks.read.mockResolvedValue({ id: "board-1", columns: defaultColumns, tags: [] });
  mocks.create.mockResolvedValue({ id: "board-1", departmentId: "dep-1", responsibleGroupId: null });
  mocks.template.mockResolvedValue({ createdById: "admin-1", templateData: { columns: [], tags: [] } });
  mocks.department.mockResolvedValue({ parentId: null, archivedAt: null });
  mocks.user.mockResolvedValue({ id: "admin-1", globalRole: "ADMIN" });
  mocks.group.mockResolvedValue({ archivedAt: null });
});

function noWrites() {
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.template).not.toHaveBeenCalled();
  expect(mocks.quota).not.toHaveBeenCalled();
}

describe("empty and template boards share one server creation path", () => {
  it("persists a versioned receipt and replays the same operation without a second board", async () => {
    const operationId = "9d676b98-c773-4547-b861-af0755ff58a1";
    const body = { name: "Board", departmentId: "dep-1", description: "Description", operationId };
    const first = await createProject(request(body));
    expect(first.status).toBe(201);
    const saved = mocks.receiptCreate.mock.calls[0][0].data;
    expect(saved).toMatchObject({ actorId: "admin-1", operationId, operation: "createBoard",
      expectedVersion: 0, committedVersion: 1, targetId: "board-1" });
    mocks.receiptFind.mockResolvedValue({ ...saved, before: null });
    mocks.state.mockResolvedValue({ version: 5 });
    const replay = await createProject(request(body));
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(await first.json());
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.receiptCreate).toHaveBeenCalledOnce();
  });

  it("assigns a fresh UUID to each request without an operationId", async () => {
    for (let index = 0; index < 2; index++) {
      expect((await createProject(request({ name: "Board", departmentId: "dep-1" }))).status).toBe(201);
    }
    const ids = mocks.receiptCreate.mock.calls.map(call => call[0].data.operationId);
    expect(ids[0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("localizes default column names without changing their workflow identifiers", () => {
    expect(DEFAULT_BOARD_COLUMNS).toEqual(defaultColumns);
    expect(DEFAULT_BOARD_COLUMNS.map(column => column.workflowKey))
      .toEqual(["TODO", "IN_PROGRESS", "NEEDS_INFO", "REVIEW", "DONE"]);
  });

  it("writes Project, columns, tags and no access policy in one nested create", async () => {
    expect((await createProject(request({ name: "Board", departmentId: "dep-1" }))).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
      data: { name: "Board", ownerId: "admin-1", departmentId: "dep-1", responsibleGroupId: null,
        columns: { create: defaultColumns.map(c=>({...c,id:expect.any(String)})) },
        lifecycleColumnMap: {contractVersion:1,...Object.fromEntries(["submittedColumnId","inProgressColumnId","needsInfoColumnId","completedColumnId","closedColumnId"].map(key=>[key,expect.any(String)]))} },
      select: { id: true, departmentId: true, responsibleGroupId: true },
    });
    const written = mocks.create.mock.calls[0][0].data;
    const fields=["submittedColumnId","inProgressColumnId","needsInfoColumnId","completedColumnId","closedColumnId"];
    expect(new Set(written.columns.create.map((c:{id:string})=>c.id)).size).toBe(5);
    fields.forEach((field,index)=>expect(written.lifecycleColumnMap[field]).toBe(written.columns.create[index].id));
    expect(mocks.receiptCreate).toHaveBeenCalledOnce();
    expect(mocks.read).toHaveBeenCalledWith({ where: { id: "board-1" }, include });
  });

  it("produces the same nested shape for a template board", async () => {
    expect((await applyTemplate(request({ projectName: "Board" }), params())).status).toBe(201);
    const templateData = mocks.create.mock.calls[0][0];
    expect(templateData).toEqual({
      data: { name: "Board", description: null, ownerId: "admin-1",
        columns: { create: [] }, tags: { create: [] } },
      include,
    });
  });

  it("binds department and access profile into the same nested create", async () => {
    mocks.department.mockResolvedValueOnce({ parentId: "dep-parent", archivedAt: null })
      .mockResolvedValueOnce({ parentId: null, archivedAt: null });
    const response = await createProject(request({
      name: "Board",
      departmentId: "dep-1",
      accessProfile: {
        allEmployees: false,
        userIds: ["subject-2", "subject-1", "subject-2"],
        departmentIds: [],
        groupIds: [],
      },
    }));
    expect(response.status).toBe(201);
    expect(mocks.department.mock.calls.map(call => call[0].where.id)).toEqual(["dep-1", "dep-parent"]);
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: "board-1" }, data: {
        description: null,
        applicantPolicyConfig: { create: { policy: {
          allEmployees: false, userIds: ["subject-1", "subject-2"], departmentIds: [], groupIds: [],
        } } },
      },
    });
  });

  it("does not let the payload choose the owner or copy template members, cards or secrets", async () => {
    mocks.template.mockResolvedValue({
      createdById: "other-creator",
      templateData: {
        availability: "organization",
        columns: [{ name: "Review", color: "#fff", position: 0, workflowKey: "REVIEW", members: [{ userId: "foreign" }] }],
        tags: [{ name: "Tag", color: "#000", projectId: "foreign" }],
        ownerId: "foreign", members: [{ userId: "foreign", role: "OWNER" }],
        tasks: [{ title: "Hidden" }], automationRules: [{ secret: "synthetic-secret" }],
      },
    });
    const response = await applyTemplate(request({
      projectName: "Board", ownerId: "foreign", members: ["foreign"], tasks: ["Hidden"],
    }), params());
    expect(response.status).toBe(201);
    const data = mocks.create.mock.calls[0][0].data;
    expect(data.ownerId).toBe("admin-1");
    expect(JSON.stringify(data)).not.toMatch(/foreign|Hidden|synthetic-secret|OWNER/);
    expect(Object.keys(data).sort()).toEqual(["columns", "description", "name", "ownerId", "tags"]);
  });

  it("fails the whole creation when the single write fails", async () => {
    mocks.create.mockRejectedValue(new Error("synthetic-private-sentinel"));
    const response = await createProject(request({ name: "Board", departmentId: "dep-1" }));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("synthetic-private-sentinel");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.log.mock.calls).toEqual([[{ event: "project.create.failed", route: "/api/projects" }]]);
  });
});

describe("board creation access control", () => {
  it.each([undefined, null, "", "   ", 123, "x".repeat(129)])(
    "rejects an absent or invalid owner department %j before quota, lookups and writes", async departmentId => {
      const response = await createProject(request({ name: "Board", departmentId }));
      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toContain("подразделение");
      noWrites();
      expect(mocks.department).not.toHaveBeenCalled();
    },
  );

  it("normalizes the required active owner department before the single write", async () => {
    const response = await createProject(request({ name: "Board", departmentId: "  dep-1  " }));
    expect(response.status).toBe(201);
    expect(mocks.create.mock.calls[0][0].data.departmentId).toBe("dep-1");
  });

  it("denies creation in another department through the global-admin guard", async () => {
    mocks.auth.mockResolvedValue({ id: "user-1", globalRole: "USER", primaryDepartmentId: "dep-own" });
    const response = await createProject(request({ name: "Board", departmentId: "dep-other" }));
    expect(response.status).toBe(403);
    noWrites();
    expect(mocks.department).not.toHaveBeenCalled();
  });

  it.each([
    { id: "user-1", globalRole: "USER" },
    { id: "user-1", globalRole: "USER", departmentRole: "ADMIN" },
    { id: "user-1", globalRole: "USER", role: "OWNER" },
  ])("denies a non-global-admin %j before any lookup or write", async (user) => {
    mocks.auth.mockResolvedValue(user);
    expect((await createProject(request({ name: "Board", globalRole: "ADMIN" }))).status).toBe(403);
    expect((await applyTemplate(request({ projectName: "Board" }), params())).status).toBe(403);
    noWrites();
  });

  it("keeps unauthenticated creation as 401", async () => {
    mocks.auth.mockRejectedValue(new UnauthorizedError());
    expect((await createProject(request({ name: "Board" }))).status).toBe(401);
    noWrites();
  });

  it("rejects an invalid access profile before quota and writes", async () => {
    expect((await createProject(request({
      name: "Board",
      departmentId: "dep-1",
      accessProfile: { allEmployees: true, userIds: ["subject-1"], departmentIds: [], groupIds: [] },
    }))).status).toBe(400);
    expect(mocks.quota).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    { allEmployees: false, userIds: ["x".repeat(129)], departmentIds: [], groupIds: [] },
    { allEmployees: false, userIds: ["bad id"], departmentIds: [], groupIds: [] },
    { allEmployees: false, userIds: [], departmentIds: Array.from({ length: 21 }, (_, index) => `dep-${index}`), groupIds: [] },
  ])("rejects malformed access profile %j", async (accessProfile) => {
    expect((await createProject(request({ name: "Board", departmentId: "dep-1", accessProfile }))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("accepts an explicit nobody profile", async () => {
    expect((await createProject(request({
      name: "Board",
      departmentId: "dep-1",
      accessProfile: { allEmployees: false, userIds: [], departmentIds: [], groupIds: [] },
    }))).status).toBe(201);
    expect(mocks.update.mock.calls[0][0].data.applicantPolicyConfig).toEqual({ create: { policy: {
      allEmployees: false, userIds: [], departmentIds: [], groupIds: [],
    } } });
  });

  it.each([
    { name: "archived department", department: { parentId: null, archivedAt: new Date("2026-10-01") } },
    { name: "missing department", department: null },
  ])("rejects %s before writes", async ({ department }) => {
    mocks.department.mockResolvedValue(department);
    expect((await createProject(request({ name: "Board", departmentId: "dep-1" }))).status).toBe(department ? 409 : 400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects an archived ancestor", async () => {
    mocks.department.mockResolvedValueOnce({ parentId: "dep-parent", archivedAt: null })
      .mockResolvedValueOnce({ parentId: null, archivedAt: new Date("2026-10-01") });
    expect((await createProject(request({ name: "Board", departmentId: "dep-1" }))).status).toBe(409);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects a missing access-profile subject", async () => {
    mocks.user.mockResolvedValue(null);
    expect((await createProject(request({
      name: "Board",
      departmentId: "dep-1",
      accessProfile: { allEmployees: false, userIds: ["missing"], departmentIds: [], groupIds: [] },
    }))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects an archived access-profile group", async () => {
    mocks.group.mockResolvedValue({ archivedAt: new Date("2026-10-01") });
    expect((await createProject(request({
      name: "Board",
      departmentId: "dep-1",
      accessProfile: { allEmployees: false, userIds: [], departmentIds: [], groupIds: ["grp-1"] },
    }))).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
