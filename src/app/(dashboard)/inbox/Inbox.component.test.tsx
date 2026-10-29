import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { taskReadPredicate } from "@/lib/access-policy";
import { TASK_LIST_MAX_LIMIT } from "@/lib/task-list-limits";

const db = vi.hoisted(() => ({
  user: { id: "actor-A", globalRole: "USER" },
  denied: false,
  findMany: vi.fn(),
  grants: vi.fn(),
  boards: vi.fn(),
}));

vi.mock("@/lib/require-user", () => ({
  requireDbUser: async () => {
    if (db.denied) throw Object.assign(new Error("UNAUTHORIZED"), { status: 401 });
    return db.user;
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findMany: db.findMany },
    project: { findMany: db.boards },
    scopedPrivilegeAssignment: { findMany: db.grants },
  },
}));

import InboxPage from "./page";
import { RelativeTime } from "./relative-time";

// The narrowing that `assignedToMe=true` adds in src/app/api/tasks/route.ts.
const assignedToMe = (actorId: string) => [
  { request: { is: { contractVersion: 1, executorId: actorId, deletedAt: null } } },
  { request: { is: null }, assignees: { some: { userId: actorId } } },
];

const row = {
  id: "task-A",
  title: "Новая задача",
  status: "TODO",
  priority: "CRITICAL",
  deadline: null as Date | null,
  createdAt: new Date("2026-10-20T10:00:00.000Z"),
  project: { id: "project", name: "Доска" },
};

beforeEach(() => {
  vi.unstubAllEnvs();
  db.user.id = "actor-A";
  db.user.globalRole = "USER";
  db.denied = false;
  db.grants.mockResolvedValue([]);
  db.boards.mockResolvedValue([{ id: "project" }]);
  db.findMany.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("inbox server page", () => {
  it("renders the assigned TODO tasks from server data, not a client fetch", async () => {
    db.findMany.mockResolvedValue([
      row,
      {
        ...row,
        id: "task-B",
        title: "Другой срок",
        priority: "FUTURE",
        deadline: new Date("2026-11-01T09:00:00.000Z"),
        createdAt: new Date("invalid"),
      },
    ]);

    const html = renderToStaticMarkup(await InboxPage());

    expect(html).toContain("Новая задача");
    expect(html).toContain("Доска");
    expect(html).toContain('href="/projects/project/board?task=task-A"');
    expect(html).toContain("priority-critical");
    expect(html).toContain("Неизвестный приоритет");
    // The server emits a stable absolute date; the relative label is client-only.
    expect(html).toContain("2026-10-20");
    expect(html).toContain("2026-11-01");
    expect(html).not.toMatch(/назад|через/);
    // Invalid timestamps stay readable instead of crashing the render.
    expect(html).toContain("дата недоступна");
    expect(html).not.toContain("Загрузка");
  });

  it("reads with the same predicate, projection, ordering and cap as GET /api/tasks", async () => {
    db.findMany.mockResolvedValue([]);

    await InboxPage();

    expect(db.findMany).toHaveBeenCalledTimes(1);
    const [query] = db.findMany.mock.calls[0]!;
    expect(query.take).toBe(TASK_LIST_MAX_LIMIT);
    expect(query.orderBy).toEqual({ position: "asc" });
    expect(query.where).toEqual({ AND: [
      taskReadPredicate({ id: "actor-A", globalRole: "USER" }, ["project"], [], true),
      { projectId: { in: ["project"] } },
      { OR: assignedToMe("actor-A"), status: "TODO" },
    ] });
    expect(Object.keys(query.include).sort()).toEqual(["_count", "assignees", "column", "project", "tags"]);
    expect(query.include.project).toEqual({ select: { id: true, name: true } });
    expect(query.include._count).toEqual({ select: { messages: true, checklistItems: true } });
  });

  it("keeps the shared read predicate ahead of the narrowing filters on an OWN board", async () => {
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "own");
    db.boards.mockResolvedValue([{ id: "own" }]);
    db.findMany.mockResolvedValue([]);

    await InboxPage();

    const [query] = db.findMany.mock.calls[0]!;
    expect(query.where).toEqual({ AND: [
      taskReadPredicate({ id: "actor-A", globalRole: "USER" }, ["own"], [], true),
      { projectId: { in: ["own"] } },
      { OR: assignedToMe("actor-A"), status: "TODO" },
    ] });
  });

  it("gives a global administrator the same narrowed list", async () => {
    db.user.globalRole = "ADMIN";
    db.findMany.mockResolvedValue([]);

    await InboxPage();

    const [query] = db.findMany.mock.calls[0]!;
    expect(query.where).toEqual({ OR: assignedToMe("actor-A"), status: "TODO" });
  });

  it("explains that an empty inbox covers only assigned TODO tasks", async () => {
    db.findMany.mockResolvedValue([]);

    const html = renderToStaticMarkup(await InboxPage());

    expect(html).toContain("Нет новых задач");
    expect(html).toContain("Задачи в других статусах здесь не показаны");
    expect(html).not.toContain("Все задачи выполнены");
  });

  it("surfaces a read failure instead of rendering an empty success", async () => {
    db.findMany.mockRejectedValue(Object.assign(new Error("private-details"), { status: 403 }));

    await expect(InboxPage()).rejects.toThrow("private-details");
  });

  it("reads nothing for a denied account and leaks no rows", async () => {
    db.denied = true;

    await expect(InboxPage()).rejects.toThrow("UNAUTHORIZED");
    expect(db.findMany).not.toHaveBeenCalled();
  });

  it("reads fresh server data on every visit instead of dropping a client cache", async () => {
    db.findMany.mockResolvedValue([row]);

    await InboxPage();
    await InboxPage();

    // A repeat visit is a fresh server read; nothing is removed or refetched
    // from a client cache, which is what made every earlier visit cold.
    expect(db.findMany).toHaveBeenCalledTimes(2);
  });

  it("stays server-rendered and never discards a client cache on unmount", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/(dashboard)/inbox/page.tsx"), "utf8");

    expect(source).not.toMatch(/^\s*["']use client["']/m);
    expect(source).not.toContain("@tanstack/react-query");
    expect(source).not.toContain("removeQueries");
    expect(source).not.toContain("cancelQueries");
    expect(source).not.toContain("apiFetch");
  });
});

describe("relative dates", () => {
  it("hydrates the absolute fallback without a mismatch, then shows relative time", async () => {
    const value = new Date(Date.now() - 2 * 86_400_000);
    const serverHtml = renderToStaticMarkup(<RelativeTime value={value} />);
    expect(serverHtml).toContain(value.toISOString().slice(0, 10));
    expect(serverHtml).not.toContain("назад");

    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.appendChild(container);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, <RelativeTime value={value} />);
    });

    expect(errors).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/назад/);

    act(() => root?.unmount());
    container.remove();
    errors.mockRestore();
  });

  it("keeps an invalid timestamp readable on both sides", () => {
    const html = renderToStaticMarkup(<RelativeTime value={new Date("invalid")} />);

    expect(html).toContain("дата недоступна");
    expect(html).not.toContain("dateTime");
  });
});
