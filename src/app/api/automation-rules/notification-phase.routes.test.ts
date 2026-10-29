import { beforeEach, describe, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ authenticated: true, role: "USER", allowed: true, actions: [] as unknown,
  create: vi.fn(), update: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  project: { findFirst: async () => fake.allowed ? { id: "project" } : null },
  automationRule: {
    findUnique: async () => ({ id: "rule", projectId: "project", trigger: "task_created", active: true, actions: fake.actions,
      project: { ownerId: fake.allowed ? "actor" : "other", members: [] } }),
    create: fake.create, update: fake.update, delete: fake.remove,
  },
} }));
vi.mock("@/lib/require-api-user", () => {
  class UnauthorizedError extends Error {}
  return { UnauthorizedError, requireApiUser: async () => { if (!fake.authenticated) throw new UnauthorizedError(); return { id: "actor", globalRole: fake.role }; } };
});
import { POST } from "./route";
import { PATCH, DELETE, GET } from "./[id]/route";
const context = { params: Promise.resolve({ id: "rule" }) };
const supported = [{ type: "notify_assignees", params: { title: "synthetic-private-title" } }];
function request(method: string, body?: unknown) { return new Request("http://localhost/api/automation-rules/rule", { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
beforeEach(() => { vi.clearAllMocks(); fake.authenticated = true; fake.allowed = true; fake.role = "USER"; fake.actions = [{ type: "unknown_action", params: { userId: "synthetic-private-user" } }]; fake.create.mockResolvedValue({ id: "created" }); fake.update.mockResolvedValue({ id: "rule" }); fake.remove.mockResolvedValue({}); });
describe("automation notification phase API", () => {
  it.each([null, 3, "payload", []].map(body => ({ body })))("rejects non-object body %# for POST/PATCH without writes", async ({ body }) => {
    expect((await POST(request("POST", body))).status).toBe(400);
    expect((await PATCH(request("PATCH", body), context)).status).toBe(400);
    expect(fake.create).not.toHaveBeenCalled(); expect(fake.update).not.toHaveBeenCalled();
  });
  it.each(["unknown_action", "add_comment", "add_tag"])("rejects POST mixed %s with no write or payload echo", async type => {
    const response = await POST(request("POST", { projectId: "project", name: "synthetic-private-name", trigger: "task_created", actions: [...supported, { type, params: { userId: "synthetic-private-user" } }] }));
    expect(response.status).toBe(400); expect(JSON.stringify(await response.json())).not.toContain("synthetic-private"); expect(fake.create).not.toHaveBeenCalled();
  });
  it.each([
    { type: "move_to_column", params: { columnId: "column-2" } },
    { type: "change_priority", params: { priority: "HIGH" } },
    { type: "assign_user", params: { userId: "member" } },
  ])("admits mixed notification and $type in POST and PATCH", async action => {
    const actions = [...supported, action];
    expect((await POST(request("POST", { projectId: "project", name: "rule", trigger: "task_created", actions }))).status).toBe(201);
    expect(fake.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ actions }) }));
    fake.actions = actions;
    expect((await PATCH(request("PATCH", { active: true }), context)).status).toBe(200);
    expect((await PATCH(request("PATCH", { actions }), context)).status).toBe(200);
    expect(fake.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ actions }) }));
  });
  it("persists supported actions through common admission", async () => {
    expect((await POST(request("POST", { projectId: "project", name: "rule", trigger: "task_created", actions: supported }))).status).toBe(201);
    expect(fake.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ actions: supported, createdById: "actor" }) }));
  });
  it.each([{ active: true }, { trigger: "priority_changed" }, { conditions: [] }])("rejects execution-changing PATCH %# if stored actions unsupported", async body => {
    const response = await PATCH(request("PATCH", body), context); expect(response.status).toBe(400); expect(fake.update).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain("synthetic-private");
  });
  it.each([{ active: false }, { name: "safe rename" }])("allows safe disable/rename %# without overwriting stored actions", async body => {
    expect((await PATCH(request("PATCH", body), context)).status).toBe(200);
    expect(fake.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining(body) }));
    const args = fake.update.mock.calls[0][0]; expect(args.data.actions).toBeUndefined();
  });
  it("allows replacement+activation with supported actions", async () => {
    expect((await PATCH(request("PATCH", { actions: supported, active: true }), context)).status).toBe(200);
    expect(fake.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ actions: supported, active: true }) }));
  });
  it("rejects unsupported replacement even while disabling", async () => {
    expect((await PATCH(request("PATCH", { actions: fake.actions, active: false }), context)).status).toBe(400); expect(fake.update).not.toHaveBeenCalled();
  });
  it("preserves GET and DELETE of old unsupported rules", async () => {
    expect((await GET(request("GET"), context)).status).toBe(200);
    expect((await DELETE(request("DELETE"), context)).status).toBe(200); expect(fake.remove).toHaveBeenCalledOnce();
  });
  it.each(["move_to_column", "custom", "status", ""])("rejects unknown POST trigger %# without a write", async trigger => {
    const response = await POST(request("POST", { projectId: "project", name: "rule", trigger, actions: supported }));
    expect(response.status).toBe(400); expect(fake.create).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain("synthetic-private");
  });
  it("rejects a PATCH trigger outside the closed catalog without a write", async () => {
    expect((await PATCH(request("PATCH", { trigger: "column_moved" }), context)).status).toBe(400);
    expect(fake.update).not.toHaveBeenCalled();
  });
  it.each(["POST", "PATCH"])("preserves %s current auth bounds", async method => {
    fake.authenticated = false;
    const call = () => method === "POST" ? POST(request("POST", { projectId: "project", name: "rule", trigger: "task_created", actions: supported })) : PATCH(request("PATCH", { actions: supported }), context);
    expect((await call()).status).toBe(401);
    fake.authenticated = true; fake.allowed = false; expect((await call()).status).toBe(403); expect(fake.create).not.toHaveBeenCalled(); expect(fake.update).not.toHaveBeenCalled();
  });
});
