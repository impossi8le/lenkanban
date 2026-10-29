import { describe, expect, it, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({ user: vi.fn(), projects: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { project: { findMany: mocks.projects } } }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: mocks.user, UnauthorizedError: class UnauthorizedError extends Error {} }));
vi.mock("@/lib/request-direction-options", () => ({ resolveRequestDirections: mocks.resolve }));
import { GET } from "./route";
import { UnauthorizedError } from "@/lib/require-api-user";
import { requestDirectionDiscoveryWhere } from "@/lib/request-direction-discovery";
beforeEach(() => vi.clearAllMocks());
describe("request direction chooser API", () => {
  it("requires authentication before discovering boards", async () => {
    mocks.user.mockRejectedValue(new UnauthorizedError());
    const response = await GET(new Request("http://localhost/api/request-directions"));
    expect(response.status).toBe(401); expect(mocks.projects).not.toHaveBeenCalled();
  });
  it("bounds metadata discovery and delegates creation rights and delegates creation rights", async () => {
    const user = { id: "user", globalRole: "USER" as const }; const boards = [{ id: "it", name: "Техподдержка" }];
    mocks.user.mockResolvedValue(user); mocks.projects.mockResolvedValue(boards); mocks.resolve.mockResolvedValue({ support: { projectId: "it", projectName: "Техподдержка" } });
    const response = await GET(new Request("http://localhost/api/request-directions"));
    expect(response.status).toBe(200);
    expect(mocks.projects).toHaveBeenCalledWith(expect.objectContaining({ where: requestDirectionDiscoveryWhere(user), take: 40 }));
    expect(mocks.resolve).toHaveBeenCalledWith(user, boards);
    expect(await response.json()).toEqual(expect.objectContaining({ data: { support: { projectId: "it", projectName: "Техподдержка" } } }));
  });
});
