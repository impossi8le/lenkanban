import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({ user: vi.fn(), scope: vi.fn(), list: vi.fn(), count: vi.fn() }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: mocks.user }));
vi.mock("@/lib/project-access", () => ({ getTaskReadWhere: mocks.scope }));
vi.mock("@/lib/prisma", () => ({ prisma: { task: { findMany: mocks.list, count: mocks.count } } }));
import ManagerPage from "./page";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: "leader", globalRole: "USER" });
  mocks.scope.mockImplementation(async (_user, filters) => ({ AND: [{ projectId: "readable" }, filters] }));
  mocks.list.mockResolvedValue([]);
  mocks.count.mockResolvedValue(0);
});
describe("manager view server boundary", () => {
  it("uses the exact shared read scope for both list and count and renders all queues", async () => {
    const html = renderToStaticMarkup(await ManagerPage({ searchParams: Promise.resolve({ queue: "upcoming", from: "2026-10-22", to: "2026-10-23" }) }));
    expect(mocks.scope).toHaveBeenCalledWith({ id: "leader", globalRole: "USER" }, expect.any(Object));
    expect(mocks.list.mock.calls[0][0].where).toEqual(mocks.count.mock.calls[0][0].where);
    expect(mocks.list.mock.calls[0][0].where.AND[0]).toEqual({ projectId: "readable" });
    for (const label of ["Просроченные", "Ближайшие 7 дней", "Без исполнителя", "По периоду", "Показать"]) expect(html).toContain(label);
    expect(html).toContain('value="2026-10-22"');
  });
  it("rejects invalid dates before querying tasks", async () => {
    const html = renderToStaticMarkup(await ManagerPage({ searchParams: Promise.resolve({ queue: "period", from: "2026-02-30" }) }));
    expect(html).toContain('role="alert"');
    expect(mocks.scope).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.count).not.toHaveBeenCalled();
  });
  it("does not query data without an authenticated user", async () => {
    mocks.user.mockRejectedValue(new Error("unauthorized"));
    await expect(ManagerPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("unauthorized");
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("escapes task titles and shows the bounded list notice", async () => {
    mocks.list.mockResolvedValue([{ id: "task", projectId: "project", title: "<script>secret</script>", deadline: null }]);
    mocks.count.mockResolvedValue(101);
    const html = renderToStaticMarkup(await ManagerPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>secret");
    expect(html).toContain("Показаны первые 100");
    expect(html).toContain("/projects/project/board?task=task");
  });
});
