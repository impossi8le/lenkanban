import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskReadPredicate } from "@/lib/access-policy";

const runtime = vi.hoisted(() => ({
  database: {} as Record<string, unknown>,
  user: { id: "actor", globalRole: "USER" } as { id: string; globalRole: string } | null,
  error: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(runtime.database, key) }) }));
vi.mock("@/lib/require-api-user", () => {
  class UnauthorizedError extends Error {}
  return {
    requireApiUser: vi.fn(async () => {
      if (!runtime.user) throw new UnauthorizedError();
      return runtime.user;
    }),
    UnauthorizedError,
  };
});
vi.mock("@/lib/logger", () => ({ apiLogger: { error: runtime.error }, dbLogger: { error: vi.fn() } }));

import { GET } from "./route";

type Row = {
  taskId: string;
  projectId: string;
  title?: string;
  projectName?: string;
  messageId?: string;
  contentText?: string;
  createdAt?: string;
  readBy?: Record<string, string>;
  author?: { name: string | null; email: string };
};

function row(input: Row) {
  const taskId = input.taskId;
  return {
    taskId,
    contentText: input.contentText ?? `text-${input.messageId ?? taskId}`,
    createdAt: new Date(input.createdAt ?? "2026-10-21T10:00:00.000Z"),
    readBy: input.readBy ?? {},
    author: input.author ?? { name: "Автор", email: `author-${taskId}@example.test` },
    task: {
      id: taskId,
      title: input.title ?? `Задача ${taskId}`,
      projectId: input.projectId,
      project: { name: input.projectName ?? `Проект ${input.projectId}` },
    },
  };
}

function fixture(rows: ReturnType<typeof row>[]) {
  const findMany = vi.fn(async () => rows);
  const grants = vi.fn(async () => []);
  const boardIds = rows.length ? [...new Set(rows.map(message => message.task.projectId))] : ["project"];
  const boards = vi.fn(async () => boardIds.map(id => ({ id })));
  runtime.database = {
    chatMessage: { findMany },
    project: { findMany: boards },
    scopedPrivilegeAssignment: { findMany: grants },
  };
  return { findMany, grants, boards };
}

const call = () => GET(new Request("https://app.test/api/messages/threads"));

beforeEach(() => { vi.clearAllMocks(); runtime.user = { id: "actor", globalRole: "USER" }; });
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/messages/threads", () => {
  it("serves 20 unread tasks with a single storage query", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => row({
      taskId: `task-${index}`,
      projectId: `project-${index % 4}`,
      messageId: `message-${index}`,
    }));
    const f = fixture(rows);

    const response = await call();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items).toHaveLength(20);
    expect(body.total).toBe(20);
    // The count of queries does not grow with the number of tasks (the old
    // page issued 2N requests: one task read and one message page per task).
    expect(f.findMany).toHaveBeenCalledTimes(1);
    expect(f.boards).toHaveBeenCalledExactlyOnceWith({ select: { id: true } });
    expect(f.grants).toHaveBeenCalledExactlyOnceWith({
      where: { userId: "actor", profile: { archivedAt: null } },
      select: { id: true, userId: true, profileId: true, scopeKind: true, projectId: true, departmentId: true, profile: { select: { id: true, permissions: true, archivedAt: true } } },
    });
  });

  it("applies the shared task read predicate instead of project membership", async () => {
    const f = fixture([row({ taskId: "visible", projectId: "project" })]);
    const response = await call();

    expect(response.status).toBe(200);
    const [args] = f.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }];
    expect(args.where.task).toEqual({ AND: [
      taskReadPredicate({ id: "actor", globalRole: "USER" }, ["project"], [], true),
      { projectId: { in: ["project"] } }, {},
    ] });
    expect(args.where).toMatchObject({ isInternal: false });
  });

  it("uses mandatory OWN on stored boards independently of the environment allowlist", async () => {
    vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "own-board");
    const f = fixture([]);
    await call();
    const [args] = f.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }];
    expect(args.where.task).toEqual({ AND: [
      taskReadPredicate({ id: "actor", globalRole: "USER" }, ["own-board", "project"], [], true),
      { projectId: { in: ["own-board", "project"] } }, {},
    ] });
  });

  it("never lists a task the caller cannot read, even when it shares the project", async () => {
    // The storage applies the predicate: rows of a hidden OWN task never arrive.
    fixture([row({ taskId: "visible", projectId: "shared" })]);
    const response = await call();
    const body = await response.json();

    expect(body.items.map((item: { id: string }) => item.id)).toEqual(["visible"]);
    expect(JSON.stringify(body)).not.toContain("foreign");
  });

  it("drops tasks whose messages are all read", async () => {
    fixture([
      row({ taskId: "unread", projectId: "project" }),
      row({ taskId: "read", projectId: "project", readBy: { actor: "2026-10-21T11:00:00.000Z" } }),
    ]);

    const body = await (await call()).json();

    expect(body.items.map((item: { id: string }) => item.id)).toEqual(["unread"]);
    expect(body.total).toBe(1);
  });

  it("returns the newest visible message and counts only unread ones", async () => {
    fixture([
      row({ taskId: "task", projectId: "project", messageId: "newest", contentText: "Новое", createdAt: "2026-10-21T12:00:00.000Z" }),
      row({ taskId: "task", projectId: "project", messageId: "read", contentText: "Прочитано", createdAt: "2026-10-21T11:00:00.000Z", readBy: { actor: "2026-10-21T11:05:00.000Z" } }),
      row({ taskId: "task", projectId: "project", messageId: "old", contentText: "Старое", createdAt: "2026-10-21T10:00:00.000Z" }),
    ]);

    const body = await (await call()).json();

    expect(body.items).toHaveLength(1);
    expect(body.items[0].unreadCount).toBe(2);
    expect(body.items[0].lastMessage).toEqual({
      contentText: "Новое",
      createdAt: "2026-10-21T12:00:00.000Z",
      authorName: "Автор",
    });
  });

  it("falls back to the author email when no display name exists", async () => {
    fixture([row({ taskId: "task", projectId: "project", author: { name: null, email: "member@example.test" } })]);

    const body = await (await call()).json();

    expect(body.items[0].lastMessage.authorName).toBe("member@example.test");
  });

  it("returns 401 without reading messages when the caller is unauthenticated", async () => {
    runtime.user = null;
    const f = fixture([row({ taskId: "task", projectId: "project" })]);

    const response = await call();

    expect(response.status).toBe(401);
    expect(f.findMany).not.toHaveBeenCalled();
  });

  it("answers with a fixed error instead of leaking the failure", async () => {
    const findMany = vi.fn(async () => { throw new Error("private-details"); });
    runtime.database = { chatMessage: { findMany }, scopedPrivilegeAssignment: { findMany: vi.fn(async () => []) } };

    const response = await call();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("private-details");
    expect(runtime.error).toHaveBeenCalled();
  });
});
