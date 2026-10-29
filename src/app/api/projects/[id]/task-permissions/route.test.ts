import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ actor: vi.fn(), read: vi.fn(), policy: vi.fn() }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: m.actor, UnauthorizedError: class extends Error {} }));
vi.mock("@/lib/project-access", () => ({ requireProjectRead: m.read }));
vi.mock("@/lib/project-status-policy", () => ({ getProjectStatusPolicy: m.policy }));
import { GET } from "./route";
beforeEach(() => { vi.resetAllMocks(); m.actor.mockResolvedValue({ id: "applicant", globalRole: "USER" }); m.read.mockResolvedValue({ canRead: true, canWrite: true, canManageMembers: false }); });
const request = () => GET(new Request("https://app.test/api/projects/board/task-permissions"), { params: Promise.resolve({ id: "board" }) });
it("returns only a server-derived status capability and disables caching", async () => {
  m.policy.mockResolvedValue({ canChangeStatus: false });
  const response = await request();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect((await response.json()).data).toEqual({ canChangeStatus: false, canAssign: false });
  expect(m.policy).toHaveBeenCalledWith({ id: "applicant", globalRole: "USER" }, "board");
});
it("retains assignment authority for a board administrator without granting raw status changes", async () => {
  m.policy.mockResolvedValue({ canChangeStatus: false });
  m.read.mockResolvedValue({ canRead: true, canWrite: true, canManageMembers: true });
  expect((await (await request()).json()).data).toEqual({ canChangeStatus: false, canAssign: true });
});
it("does not read capability facts for an inaccessible board", async () => {
  m.read.mockRejectedValue(new Error("NotFound"));
  expect((await request()).status).toBe(404);
  expect(m.policy).not.toHaveBeenCalled();
});
it("does not expose an internal failure payload", async () => {
  m.policy.mockRejectedValue(new Error("synthetic-private-value"));
  const response = await request();
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("synthetic-private-value");
});
