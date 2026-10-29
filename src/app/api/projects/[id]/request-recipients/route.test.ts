import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), project: vi.fn(), users: vi.fn() }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: api.auth, UnauthorizedError: class UnauthorizedError extends Error {} }));
vi.mock("@/lib/project-access", () => ({ getProjectCreateAccess: api.access }));
vi.mock("@/lib/prisma", () => ({ prisma: { project: { findUnique: api.project }, user: { findMany: api.users } } }));
import { GET } from "./route";
import { UnauthorizedError } from "@/lib/require-api-user";
const run = () => GET(new Request("http://localhost/api/projects/project/request-recipients"), { params: Promise.resolve({ id: "project" }) });
const project = { departmentId: "department", department: { id: "department", archivedAt: null }, responsibleGroupId: "group", responsibleGroup: { archivedAt: null } };
beforeEach(() => { vi.clearAllMocks(); api.auth.mockResolvedValue({ id: "author", globalRole: "USER" }); api.access.mockResolvedValue({ canCreate: true }); api.project.mockResolvedValue(project); api.users.mockResolvedValue([{ id: "recipient", name: "Анна" }]); });
describe("request recipients API", () => {
  it("requires authentication before exposing the directory", async () => { api.auth.mockRejectedValue(new UnauthorizedError()); expect((await run()).status).toBe(401); expect(api.project).not.toHaveBeenCalled(); });
  it("lists active destination department staff with only IDs and names", async () => {
    const response = await run(); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ data: { recipients: [{ id: "recipient", name: "Анна" }] } });
    expect(api.access).toHaveBeenCalledWith({ id: "author", globalRole: "USER" }, "project");
    expect(api.users).toHaveBeenCalledWith({ where: { primaryDepartmentId: "department", isBlocked: false, blockedAt: null }, select: { id: true, name: true }, orderBy: { id: "asc" } });
  });
  it("denies actors without creation access before listing anyone", async () => { api.access.mockResolvedValue({ canCreate: false }); expect((await run()).status).toBe(404); expect(api.users).not.toHaveBeenCalled(); });
  it("falls back to the active group only without a department", async () => {
    api.project.mockResolvedValue({ ...project, departmentId: null, department: null }); await run();
    expect(api.users.mock.calls[0][0].where).toEqual({ isBlocked: false, blockedAt: null, responsibleGroupMemberships: { some: { groupId: "group", group: { archivedAt: null } } } });
  });
  it.each([null, { ...project, department: { id: "department", archivedAt: new Date() } }, { ...project, departmentId: null, department: null, responsibleGroupId: null }])("returns no recipients for a missing or inactive destination %#", async destination => {
    api.project.mockResolvedValue(destination); expect(await (await run()).json()).toMatchObject({ data: { recipients: [] } }); expect(api.users).not.toHaveBeenCalled();
  });
});
