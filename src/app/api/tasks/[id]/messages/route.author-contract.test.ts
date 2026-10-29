import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/socket/board-events", () => ({ emitTaskMessageCreated: vi.fn() }));

const boundary = vi.hoisted(() => ({
  user: vi.fn(), task: vi.fn(), findMessages: vi.fn(), createMessage: vi.fn(), rateLimit: vi.fn(),
  lock: vi.fn(), actor: vi.fn(), project: vi.fn(), markers: vi.fn(), marker: vi.fn(),
  boards: vi.fn(), grants: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  taskRequest: { findUnique: vi.fn(async () => null) },
  task: { findFirst: boundary.task, findUnique: vi.fn(async () => null) },
  // Discussion facts/watchers are unavailable in this author-contract fixture;
  // the routes must fall back to the ordinary public projection.
  project: { findUnique: vi.fn(async () => null), findMany: boundary.boards },
  scopedPrivilegeAssignment: { findMany: boundary.grants },
  chatMessage: { findMany: boundary.findMessages, create: boundary.createMessage },
  $queryRaw: vi.fn(async () => []),
  $transaction: (callback: (tx: object) => Promise<unknown>) => callback({
    $queryRaw: boundary.lock, user: { findUnique: boundary.actor }, project: { findUnique: boundary.project },
    taskRequest: { findMany: boundary.markers, findUnique: boundary.marker },
    task: { findFirst: boundary.task, findUnique: vi.fn(async () => ({ attachments: [] })) },
    chatMessage: { create: boundary.createMessage },
  }),
} }));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: boundary.user, UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimitOrThrowKey: boundary.rateLimit, rateLimitErrorResponse: vi.fn(),
}));
import { GET, POST } from "./route";
import { UnauthorizedError } from "@/lib/require-api-user";

// Projection-aware Prisma boundary: unsafe author:true returns all scalar
// fields, just as Prisma does. Values below are synthetic, not credentials.
const author = {
  id: "author", email: "author@example.invalid", name: "Author", avatarUrl: null,
  passwordHash: "synthetic-secret", resetToken: "synthetic-reset",
  verificationToken: "synthetic-verification", globalRole: "ADMIN",
};
function selectedMessage({ include }: { include: { author: boolean | { select: Record<string, boolean> } } }) {
  const projection = include.author;
  const publicAuthor = projection === true ? author : typeof projection === "object"
    ? Object.fromEntries(Object.entries(author).filter(([key]) => projection.select[key])) : undefined;
  return { id: "message", taskId: "task", authorId: "author", contentText: "Visible message", author: publicAuthor };
}
beforeEach(() => {
  vi.resetAllMocks();
  boundary.user.mockResolvedValue({ id: "reader", globalRole: "USER" });
  boundary.task.mockResolvedValue({ id: "task", projectId: "project" });
  boundary.boards.mockResolvedValue([{ id: "project" }]);
  boundary.grants.mockResolvedValue([]);
  boundary.lock.mockImplementation(async (parts: TemplateStringsArray) => {
    const sql = parts.join("?");
    if (sql.includes('FROM "Project"')) return [{ id: "project" }];
    if (sql.includes('FROM "Task"')) return [{ id: "task", projectId: "project", priority: "MEDIUM", version: 0 }];
    return [{ id: "reader" }];
  });
  boundary.actor.mockResolvedValue({ id: "reader", globalRole: "USER", isBlocked: false, blockedAt: null });
  boundary.project.mockResolvedValue({ id: "project", ownerId: "reader", members: [] });
  boundary.markers.mockResolvedValue([]);
  boundary.marker.mockResolvedValue(null);
  boundary.findMessages.mockImplementation(async (query) => [selectedMessage(query)]);
  boundary.createMessage.mockImplementation(async (query) => selectedMessage(query));
});

it("traverses equal-timestamp message pages in deterministic ID order without gaps", async () => {
  const records = ["message-a", "message-c", "message-b"].map(id => ({
    id, createdAt: "2026-09-14T00:00:00.000Z", taskId: "task",
  }));
  boundary.findMessages.mockImplementation(async (query: {
    orderBy: Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[];
    take: number; cursor?: { id: string }; skip?: number;
  }) => {
    const orders = Array.isArray(query.orderBy) ? query.orderBy : [query.orderBy];
    const sorted = [...records].sort((a, b) => {
      for (const order of orders) {
        for (const [field, direction] of Object.entries(order)) {
          const comparison = a[field as keyof typeof a].localeCompare(b[field as keyof typeof b]);
          if (comparison) return direction === "desc" ? -comparison : comparison;
        }
      }
      return 0;
    });
    const start = query.cursor ? sorted.findIndex(message => message.id === query.cursor!.id) + (query.skip ?? 0) : 0;
    return sorted.slice(start, start + query.take);
  });
  const context = { params: Promise.resolve({ id: "task" }) };
  const first = await GET(new Request("http://localhost/api/tasks/task/messages?limit=2"), context);
  const firstPage = (await first.json()).data;
  expect(firstPage.items.map((message: { id: string }) => message.id)).toEqual(["message-b", "message-c"]);
  expect(firstPage.nextCursor).toBe("message-b");
  const second = await GET(new Request(`http://localhost/api/tasks/task/messages?limit=2&cursor=${firstPage.nextCursor}`), context);
  const secondPage = (await second.json()).data;
  expect(secondPage.items.map((message: { id: string }) => message.id)).toEqual(["message-a"]);
  expect(secondPage.nextCursor).toBeNull();
});

describe.each(["GET", "POST"] as const)("%s message author contract", (method) => {
  async function request() {
    const context = { params: Promise.resolve({ id: "task" }) };
    return method === "GET"
      ? GET(new Request("http://localhost/api/tasks/task/messages?limit=50"), context)
      : POST(new Request("http://localhost/api/tasks/task/messages", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        body: JSON.stringify({ contentText: "Visible message" }),
      }), context);
  }

  it("returns only public author fields to an authorized project member", async () => {
    const response = await request();
    expect(response.status).toBe(method === "GET" ? 200 : 201);
    const body = await response.json();
    const message = method === "GET" ? body.data.items[0] : body.data;
    expect(Object.keys(message.author).sort()).toEqual(["avatarUrl", "email", "id", "name"]);
    expect(message.author).toEqual({ id: "author", email: "author@example.invalid", name: "Author", avatarUrl: null });
    expect(message.contentText).toBe("Visible message");
    expect(boundary.task).toHaveBeenCalledWith({
      where: expect.objectContaining({ AND: expect.arrayContaining([{ id: "task" }]) }),
      select: { id: true, projectId: true },
    });
  });

  it("returns no message data and performs no message operation when task access is denied", async () => {
    boundary.task.mockResolvedValue(null);
    const response = await request();
    expect(response.status).toBe(404);
    expect(await response.json()).not.toHaveProperty("data");
    expect(boundary.findMessages).not.toHaveBeenCalled();
    expect(boundary.createMessage).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated callers before reading or creating messages", async () => {
    boundary.user.mockRejectedValue(new UnauthorizedError());
    const response = await request();
    expect(response.status).toBe(401);
    expect(boundary.task).not.toHaveBeenCalled();
    expect(boundary.findMessages).not.toHaveBeenCalled();
    expect(boundary.createMessage).not.toHaveBeenCalled();
  });
});
