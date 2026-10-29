import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), quota: vi.fn(), template: vi.fn(), listTemplates: vi.fn(), listProjects: vi.fn(),
  create: vi.fn(), transaction: vi.fn(), txCreate: vi.fn(), txColumns: vi.fn(), department: vi.fn(),
  audited: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  projectTemplate: { findUnique: mocks.template, findMany: mocks.listTemplates },
  project: { create: mocks.create, findMany: mocks.listProjects }, $transaction: mocks.transaction,
  department: { findUnique: mocks.department },
} }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: mocks.auth, UnauthorizedError: class UnauthorizedError extends Error {} }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/rate-limit")>(), rateLimitOrThrowKey: mocks.quota,
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn() } }));
// Keep require-user/isGlobalAdmin real; isolate only its unused session dependencies.
vi.mock("@/lib/nextauth", () => ({ nextAuthOptions: {} }));
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("../projects/board-creation", async original => ({
  ...await original<typeof import("../projects/board-creation")>(), createAuditedBoard: mocks.audited,
}));

import { UnauthorizedError } from "@/lib/require-api-user";
import { GET as listProjects, POST as createProject } from "../projects/route";
import { GET as listTemplates } from "./route";
import { POST as applyTemplate } from "./[id]/use/route";

function request(body: unknown) {
  return new Request("http://localhost/api/projects", { method: "POST", body: JSON.stringify(body) });
}
const endpoints = [
  { name: "plain", call: (body: object) => createProject(request({ name: "Board", ...body })) },
  { name: "template", call: (body: object) => applyTemplate(request({ projectName: "Board", ...body }), { params: Promise.resolve({ id: "template-1" }) }) },
];
const users = [
  { name: "ordinary employee", user: { id: "actor-1", globalRole: "USER" } },
  { name: "department administrator", user: { id: "actor-1", globalRole: "USER", departmentRole: "ADMIN", isDepartmentAdmin: true } },
  { name: "group leader", user: { id: "actor-1", globalRole: "USER", groupRole: "LEADER", isLeader: true } },
  { name: "existing board owner", user: { id: "actor-1", globalRole: "USER", role: "OWNER", ownedProjectIds: ["project-1"] } },
  { name: "template creator", user: { id: "actor-1", globalRole: "USER", createdTemplateIds: ["template-1"] } },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ id: "actor-1", globalRole: "USER" });
  mocks.quota.mockResolvedValue(undefined);
  mocks.department.mockResolvedValue({ parentId: null, archivedAt: null });
  mocks.template.mockResolvedValue({ createdById: "actor-1", templateData: { columns: [], tags: [] } });
  mocks.create.mockResolvedValue({ id: "template-project" });
  mocks.audited.mockResolvedValue({ id: "plain-project", columns: defaultColumns, tags: [] });
  mocks.txCreate.mockResolvedValue({ id: "plain-project" });
  mocks.txColumns.mockResolvedValue({ count: 4 });
  mocks.transaction.mockImplementation(async (operation) => operation({
    project: { create: mocks.txCreate }, projectColumn: { createMany: mocks.txColumns },
  }));
  mocks.listProjects.mockResolvedValue([]);
  mocks.listTemplates.mockResolvedValue([]);
});

function noCreationWork() {
  expect(mocks.audited).not.toHaveBeenCalled();
  expect(mocks.template).not.toHaveBeenCalled();
  expect(mocks.quota).not.toHaveBeenCalled();
  expect(mocks.transaction).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.txCreate).not.toHaveBeenCalled();
  expect(mocks.txColumns).not.toHaveBeenCalled();
}

const defaultColumns = [
  { name: "К выполнению", color: "#3b82f6", position: 0, workflowKey: "TODO" },
  { name: "В работе", color: "#f59e0b", position: 1, workflowKey: "IN_PROGRESS" },
  { name: "На проверке", color: "#0ea5e9", position: 2, workflowKey: "REVIEW" },
  { name: "Готово", color: "#10b981", position: 3, workflowKey: "DONE" },
];

describe.each(endpoints)("$name board creation requires global ADMIN", ({ call }) => {
  it.each(users)("denies $name before lookup, quota and writes", async ({ user }) => {
    mocks.auth.mockResolvedValue(user);
    expect((await call({})).status).toBe(403);
    noCreationWork();
  });

  it("ignores an ADMIN role and identity forged in JSON", async () => {
    expect((await call({ globalRole: "ADMIN", role: "ADMIN", actorId: "admin-1", ownerId: "admin-1" })).status).toBe(403);
    noCreationWork();
  });

  it("preserves unauthenticated 401", async () => {
    mocks.auth.mockRejectedValue(new UnauthorizedError());
    expect((await call({})).status).toBe(401);
    noCreationWork();
  });
});

it("lets a global ADMIN create a normal board through the audited adapter", async () => {
  mocks.auth.mockResolvedValue({ id: "admin-1", globalRole: "ADMIN" });
  expect((await createProject(request({ name: "  Board  ", description: "  Details  ", ownerId: "spoofed", departmentId: "dep-1" }))).status).toBe(201);
  expect(mocks.quota).toHaveBeenCalledExactlyOnceWith("projects:create", "admin-1");
  expect(mocks.audited).toHaveBeenCalledExactlyOnceWith({
    name: "Board", description: "Details", actorId: "admin-1", departmentId: "dep-1",
    accessProfile: null, operationId: undefined,
  });
  expect(mocks.transaction).not.toHaveBeenCalled();
});

it("lets a global ADMIN apply another creator's organization-shared template and bind ownership to the session actor", async () => {
  mocks.auth.mockResolvedValue({ id: "admin-1", globalRole: "ADMIN" });
  mocks.template.mockResolvedValue({
    createdById: "other-creator",
    templateData: { columns: [], tags: [], availability: "organization" },
  });
  expect((await applyTemplate(request({ projectName: "Board", ownerId: "spoofed" }), { params: Promise.resolve({ id: "template-1" }) })).status).toBe(201);
  expect(mocks.quota).toHaveBeenCalledExactlyOnceWith("projects:create", "admin-1");
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
    data: { name: "Board", description: null, ownerId: "admin-1", columns: { create: [] }, tags: { create: [] } },
    include: { columns: { orderBy: { position: "asc" } }, tags: true },
  });
});

it("denies another creator's private template even to a global ADMIN", async () => {
  mocks.auth.mockResolvedValue({ id: "admin-1", globalRole: "ADMIN" });
  mocks.template.mockResolvedValue({ createdById: "other-creator", templateData: { columns: [], tags: [] } });
  expect((await applyTemplate(request({ projectName: "Board" }), { params: Promise.resolve({ id: "template-1" }) })).status).toBe(403);
  expect(mocks.quota).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
});

it("preserves a non-admin's existing visible-board list access", async () => {
  expect((await listProjects(new Request("http://localhost/api/projects"))).status).toBe(200);
  expect(mocks.listProjects).toHaveBeenCalledWith(expect.objectContaining({ where: {
    OR: [{ ownerId: "actor-1" }, { members: { some: { userId: "actor-1" } } },
      { departmentId: null, responsibleGroup: { is: { archivedAt: null, members: { some: { userId: "actor-1" } } } } },
      { department: { is: { archivedAt: null } } }],
  } }));
  noCreationWork();
});

it("preserves a non-admin's existing own-template list access", async () => {
  expect((await listTemplates(new Request("http://localhost/api/project-templates"))).status).toBe(200);
  expect(mocks.listTemplates).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [{ id: "builtin-project-template-tech-support" }, { createdById: "actor-1" }] } }));
  noCreationWork();
});
