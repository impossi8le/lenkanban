import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ user: { id: "member-1", globalRole: "USER" }, count: vi.fn(), projects: vi.fn(), recent: vi.fn(), directions: vi.fn(), requireUser: vi.fn() }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: db.requireUser }));
vi.mock("@/lib/project-access", () => ({ getTaskReadWhere: async () => ({ id: { in: ["visible"] } }) }));
vi.mock("@/lib/request-direction-options", () => ({ resolveRequestDirections: db.directions }));
vi.mock("@/lib/prisma", () => ({ prisma: { project: { findMany: db.projects }, task: { count: db.count, findMany: db.recent } } }));
import { HomeActiveCount, HomeReplyBanner, HomeRecentRequests } from "@/components/dashboard/HomeData";
import { taskListVisibilityWhere } from "@/lib/task-list-visibility";

describe("demo home with real scoped requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.requireUser.mockResolvedValue(db.user);
    db.projects.mockResolvedValue([{ id: "it", name: "Техподдержка" }]);
    db.directions.mockResolvedValue({});
    db.count.mockImplementation(async (query: { where: { AND: unknown[] } }) => query.where.AND.length === 3 ? 7 : 2);
    db.recent.mockResolvedValue([{ id: "visible", title: "Нужна помощь", projectId: "it", status: "IN_PROGRESS", project: { name: "Техподдержка" }, request: { state: "NEEDS_INFO", executor: { name: "Специалист" } }, assignees: [] }]);
  });
  it("shows the demo hero, reply banner and a real recent card route", async () => {
    const html = renderToStaticMarkup(<>{await HomeActiveCount()}{await HomeReplyBanner()}{await HomeRecentRequests()}</>);
    expect(html).toContain(">7<");
    expect(html).toContain("2 обращения ждут");
    expect(html).toContain('/my-tasks?scope=reply');
    expect(html).toContain('/projects/it/tasks/visible');
    expect(html).toContain("Исполнитель: Специалист");
    expect(html).toContain("Ждём сотрудника");
    expect(html).not.toContain("Всего отделов");
  });
  it("intersects every counter with the shared read scope and bounds recent reads", async () => {
    await HomeActiveCount();
    const scopedList = { AND: [{ id: { in: ["visible"] } }, taskListVisibilityWhere()] };
    for (const [query] of db.count.mock.calls) expect(query.where.AND[0]).toEqual(scopedList);
    expect(db.count.mock.calls[1][0].where.AND[1]).toEqual({ request: { authorId: "member-1", state: "NEEDS_INFO" } });
    expect(db.recent).toHaveBeenCalledWith(expect.objectContaining({ where: scopedList, take: 4 }));
    expect(db.count.mock.calls[0][0].where.AND[2].OR[0].request.state.in).not.toContain("DRAFT");
    expect(db.projects).not.toHaveBeenCalled();
    expect(db.directions).not.toHaveBeenCalled();
  });
  it("does not read protected requests or counters when authentication fails", async () => {
    db.requireUser.mockRejectedValueOnce(new Error("UNAUTHORIZED"));
    await expect(HomeRecentRequests()).rejects.toThrow("UNAUTHORIZED");
    expect(db.count).not.toHaveBeenCalled();
    expect(db.recent).not.toHaveBeenCalled();
  });
  it("hides reply banner and shows genuine empty state", async () => {
    db.count.mockReset().mockResolvedValue(0); db.recent.mockResolvedValue([]);
    const html = renderToStaticMarkup(<>{await HomeActiveCount()}{await HomeReplyBanner()}{await HomeRecentRequests()}</>);
    expect(html).not.toContain("Обращения ждут ответа");
    expect(html).toContain("Здесь появятся ваши обращения");
  });
});

it("uses a human column name instead of exposing a storage status identifier", async () => {
  db.requireUser.mockResolvedValue(db.user);
  db.recent.mockResolvedValue([{ id: "visible", title: "Legacy", projectId: "it", status: "COLUMN_secret-id", column: { name: "В работе" }, project: { name: "Техподдержка" }, request: null, assignees: [] }]);
  const html = renderToStaticMarkup(await HomeRecentRequests());
  expect(html).toContain("В работе");
  expect(html).not.toContain("COLUMN_");
});
