import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  user: { findUnique: vi.fn() },
  project: { findUnique: vi.fn() },
  savedView: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("next-auth", () => ({ getServerSession: mocks.session }));
vi.mock("@/lib/nextauth", () => ({ nextAuthOptions: {} }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  user: mocks.user, project: mocks.project, savedView: mocks.savedView,
} }));
vi.mock("@/lib/logger", () => ({ apiLogger: mocks.logger }));

// Keep the real identity refresh and project access adapter/evaluator.
import { GET, PATCH, DELETE } from "./route";

const view = { id: "view-1", projectId: "project-1", createdById: "creator-1", name: "Private view", isDefault: false };
const actor = { id: "creator-1", email: "creator@example.test", globalRole: "USER" };
const params = () => ({ params: Promise.resolve({ id: view.id }) });
const endpoints = [{ method: "GET", call: GET }, { method: "PATCH", call: PATCH }, { method: "DELETE", call: DELETE }];

function request(method: string, body: unknown = { name: "Renamed", isDefault: true }) {
  return new NextRequest("http://localhost/api/saved-views/view-1", {
    method,
    ...(method === "PATCH" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
}

function noWrites() {
  expect(mocks.savedView.updateMany).not.toHaveBeenCalled();
  expect(mocks.savedView.update).not.toHaveBeenCalled();
  expect(mocks.savedView.delete).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ user: { ...actor, globalRole: "ADMIN" } });
  mocks.user.findUnique.mockResolvedValue(actor);
  mocks.project.findUnique.mockResolvedValue({ id: view.projectId, department: null, ownerId: "other-owner", members: [{ role: "MEMBER" }] });
  mocks.savedView.findUnique.mockResolvedValue(view);
  mocks.savedView.update.mockResolvedValue({ ...view, name: "Renamed", isDefault: true });
  mocks.savedView.updateMany.mockResolvedValue({ count: 1 });
  mocks.savedView.delete.mockResolvedValue(view);
});

describe.each(endpoints)("saved-view $method current-access boundary (mock database)", ({ method, call }) => {
  it("rejects missing session before accessing saved views", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await call(request(method), params())).status).toBe(401);
    expect(mocks.user.findUnique).not.toHaveBeenCalled();
    expect(mocks.savedView.findUnique).not.toHaveBeenCalled();
    noWrites();
  });

  it("rejects a deleted database user despite a valid creator session", async () => {
    mocks.user.findUnique.mockResolvedValue(null);
    expect((await call(request(method), params())).status).toBe(401);
    expect(mocks.user.findUnique).toHaveBeenCalledWith({ where: { email: actor.email } });
    expect(mocks.savedView.findUnique).not.toHaveBeenCalled();
    noWrites();
  });

  it("hides the view after its creator loses project membership, ignoring stale ADMIN session claims", async () => {
    mocks.project.findUnique.mockResolvedValue({ id: view.projectId, department: null, ownerId: "other-owner", members: [] });
    const input = request(method);
    const parse = vi.spyOn(input, "json");
    const response = await call(input, params());
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(view.name);
    expect(mocks.project.findUnique).toHaveBeenCalledWith({
      where: { id: view.projectId }, select: {
        id: true, ownerId: true, department: { select: { id: true, archivedAt: true } }, members: { where: { userId: actor.id }, select: { role: true }, take: 1 },
        responsibleGroup: { select: { archivedAt: true, members: { where: { userId: actor.id }, select: { userId: true }, take: 1 } } },
      },
    });
    expect(parse).not.toHaveBeenCalled();
    noWrites();
  });

  it("hides the creator's view when its project no longer exists", async () => {
    mocks.project.findUnique.mockResolvedValue(null);
    expect((await call(request(method), params())).status).toBe(404);
    noWrites();
  });

  it.each(["USER", "ADMIN"])("retains creator-only ownership for a current %s", async globalRole => {
    mocks.user.findUnique.mockResolvedValue({ ...actor, globalRole });
    mocks.savedView.findUnique.mockResolvedValue({ ...view, createdById: "someone-else" });
    expect((await call(request(method), params())).status).toBe(403);
    expect(mocks.project.findUnique).not.toHaveBeenCalled();
    noWrites();
  });

  it("uses the refreshed database identity rather than a stale creator session ID", async () => {
    mocks.user.findUnique.mockResolvedValue({ ...actor, id: "replacement-user" });
    expect((await call(request(method), params())).status).toBe(403);
    noWrites();
  });

  it("returns 404 for a missing saved view without project lookups", async () => {
    mocks.savedView.findUnique.mockResolvedValue(null);
    expect((await call(request(method), params())).status).toBe(404);
    expect(mocks.project.findUnique).not.toHaveBeenCalled();
    noWrites();
  });

  it("allows the current creator who is still a project member", async () => {
    const response = await call(request(method), params());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(mocks.user.findUnique).toHaveBeenCalledOnce();
    expect(mocks.project.findUnique).toHaveBeenCalledOnce();
    if (method === "GET") {
      expect(body.data).toEqual(view);
      noWrites();
    } else if (method === "PATCH") {
      expect(body.data).toEqual({ ...view, name: "Renamed", isDefault: true });
      expect(mocks.savedView.updateMany).toHaveBeenCalledWith({ where: {
        projectId: view.projectId, createdById: actor.id, isDefault: true, id: { not: view.id },
      }, data: { isDefault: false } });
      expect(mocks.savedView.update).toHaveBeenCalledWith({ where: { id: view.id }, data: { name: "Renamed", isDefault: true } });
    } else {
      expect(body.data).toEqual({ success: true });
      expect(mocks.savedView.delete).toHaveBeenCalledWith({ where: { id: view.id } });
    }
  });

  it("allows a current global ADMIN creator through the existing project-access rule", async () => {
    mocks.user.findUnique.mockResolvedValue({ ...actor, globalRole: "ADMIN" });
    expect((await call(request(method), params())).status).toBe(200);
    expect(mocks.user.findUnique).toHaveBeenCalledOnce();
    expect(mocks.project.findUnique).not.toHaveBeenCalled();
  });

  it("allows a current project owner without a membership row", async () => {
    mocks.project.findUnique.mockResolvedValue({ id: view.projectId, department: null, ownerId: actor.id, members: [] });
    expect((await call(request(method), params())).status).toBe(200);
    expect(mocks.project.findUnique).toHaveBeenCalledOnce();
  });

  it("returns a safe 500 when the project lookup fails before body parsing or writes", async () => {
    const secret = "SYNTHETIC_PROJECT_LOOKUP_SECRET_68124";
    mocks.project.findUnique.mockRejectedValue(Object.assign(new Error(secret), { cause: { token: secret } }));
    const input = request(method);
    const parse = vi.spyOn(input, "json");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await call(input, params());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(secret);
    expect(parse).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toContain("token");
    noWrites();
  });

  it("does not expose or log raw unexpected errors containing synthetic secrets", async () => {
    const secret = "SYNTHETIC_SAVED_VIEW_SECRET_98213";
    const failure = Object.assign(new Error(secret), { cause: { token: secret }, query: secret });
    mocks.savedView.findUnique.mockRejectedValue(failure);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await call(request(method), params());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(secret);
    expect(consoleError).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toContain("token");
    noWrites();
  });
});

describe("saved-view PATCH validation after current access", () => {
  it.each(["Task B", "", null, undefined])("preserves updated search %j on reload", async search => {
    const filters = { status: "TODO", priority: "HIGH", assignee: null, tags: ["support"], ...(search !== undefined ? { search } : {}) };
    mocks.savedView.update.mockImplementation(async ({ data }) => ({ ...view, ...data }));
    const updated = await PATCH(request("PATCH", { filters }), params());
    expect(updated.status).toBe(200);
    expect(mocks.savedView.update).toHaveBeenCalledWith({ where: { id: view.id }, data: { filters } });
    const saved = (await updated.json()).data;
    expect(saved.filters).toEqual(filters);
    mocks.savedView.findUnique.mockResolvedValue(saved);
    const loaded = await GET(request("GET"), params());
    expect(loaded.status).toBe(200);
    expect((await loaded.json()).data.filters).toEqual(filters);
  });

  it.each([{ name: "" }, { viewType: "invalid" }, { isDefault: "yes" }])("retains validation status 422 for %j", async body => {
    const response = await PATCH(request("PATCH", body), params());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    noWrites();
  });
});
