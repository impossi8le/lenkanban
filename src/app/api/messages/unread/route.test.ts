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

function fixture(messages: Array<{ taskId: string; projectId: string; readBy?: Record<string, string> }> = []) {
  const findMany = vi.fn(async () => messages.map(message => ({
    taskId: message.taskId,
    readBy: message.readBy ?? {},
    _count: { _all: 1 },
  })));
  runtime.database = {
    chatMessage: { groupBy: findMany },
    task: { findMany: vi.fn(async () => [...new Map(messages.map(message => [message.taskId, { id: message.taskId, projectId: message.projectId }])).values()]) },
    project: { findMany: vi.fn(async () => [...new Set(messages.length ? messages.map(message => message.projectId) : ["project"])].map(id => ({ id }))) },
    scopedPrivilegeAssignment: { findMany: vi.fn(async () => []) },
  };
  return { findMany };
}

const call = () => GET(new Request("https://app.test/api/messages/unread"));

beforeEach(() => { vi.clearAllMocks(); runtime.user = { id: "actor", globalRole: "USER" }; });
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/messages/unread", () => {
  it("applies the shared task read predicate instead of project membership", async () => {
    const f = fixture([{ taskId: "visible", projectId: "project" }]);
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
    const f = fixture();
    await call();
    const [args] = f.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }];
    expect(args.where.task).toEqual({ AND: [
      taskReadPredicate({ id: "actor", globalRole: "USER" }, ["own-board", "project"], [], true),
      { projectId: { in: ["own-board", "project"] } }, {},
    ] });
  });

  it("counts only visible tasks and never selects message text", async () => {
    const f = fixture([
      { taskId: "visible", projectId: "project" },
      { taskId: "visible", projectId: "project", readBy: { actor: "2026-10-22T00:00:00.000Z" } },
      { taskId: "other", projectId: "second" },
    ]);
    const response = await call();
    const body = await response.json() as { byTask: Record<string, number>; byProject: Record<string, number>; total: number };
    expect(body).toEqual({ byTask: { visible: 1, other: 1 }, byProject: { project: 1, second: 1 }, total: 2 });
    const [args] = f.findMany.mock.calls[0] as unknown as [{ by: string[]; _count: object; select?: unknown }];
    expect(args.by).toEqual(["taskId", "readBy"]);
    expect(args._count).toEqual({ _all: true });
    expect(args).not.toHaveProperty("select");
  });

  it("excludes internal comments from the counter", async () => {
    const f = fixture();
    await call();
    const [args] = f.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }];
    expect(args.where.isInternal).toBe(false);
  });

  it("returns no counts for an unauthenticated caller", async () => {
    runtime.user = null;
    const f = fixture();
    const response = await call();
    expect(response.status).toBe(401);
    expect(f.findMany).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });
});
