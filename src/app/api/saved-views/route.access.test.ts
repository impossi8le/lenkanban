import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), user: { findUnique: vi.fn() }, project: { findUnique: vi.fn() },
  savedView: { findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  logger: { error: vi.fn() },
}));
vi.mock("next-auth", () => ({ getServerSession: mocks.session }));
vi.mock("@/lib/nextauth", () => ({ nextAuthOptions: {} }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  user: mocks.user, project: mocks.project, savedView: mocks.savedView,
} }));
vi.mock("@/lib/logger", () => ({ apiLogger: mocks.logger }));
import { GET, POST } from "./route";

describe("saved-view search persistence (mock database)", () => {
  it.each(["Task A", "", null, undefined])("preserves search %j with the other filters on create and reload", async search => {
    const filters = { status: "TODO", priority: "LOW", assignee: null, tags: ["support"], ...(search !== undefined ? { search } : {}) };
    mocks.savedView.create.mockImplementation(async ({ data }) => ({ id: view.id, ...data }));
    const created = await POST(request("POST", { projectId, name: view.name, filters }));
    expect(created.status).toBe(201);
    expect(mocks.savedView.create).toHaveBeenCalledWith({ data: expect.objectContaining({ filters }) });
    const saved = (await created.json()).data;
    expect(saved.filters).toEqual(filters);
    mocks.savedView.findMany.mockResolvedValue([saved]);
    const loaded = await GET(request("GET"));
    expect(loaded.status).toBe(200);
    expect((await loaded.json()).data[0].filters).toEqual(filters);
  });
});

const actor = { id: "creator", email: "creator@example.test", globalRole: "USER" };
const projectId = "support";
const view = { id: "view", projectId, createdById: actor.id, name: "My view" };
function request(method: string, body: unknown = { projectId, name: view.name, isDefault: true }) {
  return new NextRequest(`http://localhost/api/saved-views?projectId=${projectId}`, {
    method, ...(method === "POST" ? {
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    } : {}),
  });
}
function noViewAccess() {
  expect(mocks.savedView.findMany).not.toHaveBeenCalled();
  expect(mocks.savedView.updateMany).not.toHaveBeenCalled();
  expect(mocks.savedView.create).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ user: { ...actor, globalRole: "ADMIN" } });
  mocks.user.findUnique.mockResolvedValue(actor);
  mocks.project.findUnique.mockResolvedValue({ id: projectId, department: null, ownerId: "other", members: [{ role: "MEMBER" }] });
  mocks.savedView.findMany.mockResolvedValue([view]);
  mocks.savedView.create.mockResolvedValue(view);
});

describe.each([{ method: "GET", call: GET, status: 200 }, { method: "POST", call: POST, status: 201 }])(
  "saved views collection $method (mock database)", ({ method, call, status }) => {
    it("rejects missing session and deleted accounts before view access", async () => {
      mocks.session.mockResolvedValue(null);
      expect((await call(request(method))).status).toBe(401);
      noViewAccess();
      mocks.session.mockResolvedValue({ user: actor });
      mocks.user.findUnique.mockResolvedValue(null);
      expect((await call(request(method))).status).toBe(401);
      noViewAccess();
    });

    it("ignores stale ADMIN claims when database membership has been revoked", async () => {
      mocks.project.findUnique.mockResolvedValue({ id: projectId, department: null, ownerId: "other", members: [] });
      expect((await call(request(method))).status).toBe(404);
      noViewAccess();
    });

    it("denies missing projects for ordinary users", async () => {
      mocks.project.findUnique.mockResolvedValue(null);
      expect((await call(request(method))).status).toBe(404);
      noViewAccess();
    });

    it("allows current ADMIN without a separate owner/member policy", async () => {
      mocks.user.findUnique.mockResolvedValue({ ...actor, globalRole: "ADMIN" });
      expect((await call(request(method))).status).toBe(status);
      expect(mocks.project.findUnique).not.toHaveBeenCalled();
    });

    it.each(["member", "owner"])("allows a current %s and keeps personal view ownership", async role => {
      if (role === "owner") mocks.project.findUnique.mockResolvedValue({ id: projectId, department: null, ownerId: actor.id, members: [] });
      expect((await call(request(method))).status).toBe(status);
      expect(mocks.user.findUnique).toHaveBeenCalledWith({ where: { email: actor.email } });
      expect(mocks.project.findUnique).toHaveBeenCalledExactlyOnceWith({ where: { id: projectId }, select: {
        id: true, ownerId: true, department: { select: { id: true, archivedAt: true } }, members: { where: { userId: actor.id }, select: { role: true }, take: 1 },
        responsibleGroup: { select: { archivedAt: true, members: { where: { userId: actor.id }, select: { userId: true }, take: 1 } } },
      } });
      if (method === "GET") {
        expect(mocks.savedView.findMany).toHaveBeenCalledWith({
          where: { projectId, createdById: actor.id }, orderBy: { createdAt: "desc" },
        });
        expect(mocks.savedView.create).not.toHaveBeenCalled();
      } else {
        expect(mocks.savedView.updateMany).toHaveBeenCalledWith({
          where: { projectId, createdById: actor.id, isDefault: true }, data: { isDefault: false },
        });
        expect(mocks.savedView.create).toHaveBeenCalledWith({ data: expect.objectContaining({ projectId, createdById: actor.id }) });
      }
    });

    it("binds view ownership to the refreshed DB identity", async () => {
      mocks.user.findUnique.mockResolvedValue({ ...actor, id: "fresh-id", globalRole: "ADMIN" });
      expect((await call(request(method))).status).toBe(status);
      if (method === "GET") expect(mocks.savedView.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { projectId, createdById: "fresh-id" },
      }));
      else expect(mocks.savedView.create).toHaveBeenCalledWith({ data: expect.objectContaining({ createdById: "fresh-id" }) });
    });

    it("logs only safe metadata on unexpected access lookup errors", async () => {
      const secret = "synthetic-private-value";
      mocks.project.findUnique.mockRejectedValue(Object.assign(Error(secret), { cause: { token: secret } }));
      const response = await call(request(method));
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(secret);
      expect(mocks.logger.error).toHaveBeenCalledOnce();
      expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toContain(secret);
      noViewAccess();
    });
  },
);

it("keeps collection input validation", async () => {
  expect((await GET(new NextRequest("http://localhost/api/saved-views"))).status).toBe(400);
  expect((await POST(request("POST", { projectId, name: "" }))).status).toBe(422);
  noViewAccess();
});
