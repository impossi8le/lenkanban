import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const boundary = vi.hoisted(() => ({ token: vi.fn(), used: vi.fn(), session: vi.fn(), allowed: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { apiToken: { findUnique: boundary.token, update: boundary.used } } }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: boundary.session }));
vi.mock("@/lib/auth", () => ({ isAccountAllowed: boundary.allowed }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/socket/board-events", () => ({ emitTaskMoved: vi.fn(), emitTaskUpdated: vi.fn(), emitTaskDeleted: vi.fn() }));
import { generateApiToken } from "@/lib/api-tokens";
import { UnauthorizedError } from "@/lib/errors";
import * as tasks from "./route";
import * as task from "./[id]/route";
import * as bulk from "./bulk/route";
import * as move from "./[id]/move/route";
import * as tags from "./[id]/tags/route";
import * as assignees from "./[id]/assignees/route";
import * as attachments from "./[id]/attachments/route";
import * as checklist from "./[id]/checklist/route";
import * as item from "./[id]/checklist/[itemId]/route";
import * as messages from "./[id]/messages/route";
import * as watchers from "./[id]/messages/watchers/route";
import * as read from "./[id]/messages/read/route";

const secret = generateApiToken().token;
const context = { params: Promise.resolve({ id: "task", itemId: "item" }) };
const routes = [
  { path: "", method: "POST", handler: tasks.POST, body: { title: "Task", projectId: "cm00000000000000000000000", columnId: "column" } },
  { path: "/task", method: "PATCH", handler: task.PATCH },
  { path: "/task", method: "POST", handler: task.POST },
  { path: "/task", method: "DELETE", handler: task.DELETE },
  { path: "/bulk", method: "PATCH", handler: bulk.PATCH, body: { taskIds: ["cm00000000000000000000000"], updates: { priority: "HIGH" } } },
  { path: "/task/move", method: "POST", handler: move.POST },
  { path: "/task/tags", method: "PUT", handler: tags.PUT },
  { path: "/task/assignees", method: "PUT", handler: assignees.PUT },
  { path: "/task/attachments", method: "PATCH", handler: attachments.PATCH, body: { attachments: [] } },
  { path: "/task/checklist", method: "POST", handler: checklist.POST, body: { text: "Item" } },
  { path: "/task/checklist/item", method: "PATCH", handler: item.PATCH },
  { path: "/task/checklist/item", method: "DELETE", handler: item.DELETE },
  { path: "/task/messages", method: "POST", handler: messages.POST },
  { path: "/task/messages/watchers", method: "POST", handler: watchers.POST, body: { userId: "watcher" } },
  { path: "/task/messages/watchers", method: "DELETE", handler: watchers.DELETE, body: { userId: "watcher" } },
  { path: "/task/messages/read", method: "POST", handler: read.POST },
];

beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("TELEMETRY_ENABLED", "false");
  boundary.allowed.mockResolvedValue(true);
  boundary.used.mockResolvedValue({});
  boundary.session.mockRejectedValue(new UnauthorizedError());
  boundary.token.mockResolvedValue({ id: "token", user: { id: "actor", globalRole: "ADMIN" }, scopes: [], expiresAt: null, revokedAt: null });
});
afterEach(() => vi.unstubAllEnvs());

describe.each(routes)("token authentication: $method /api/tasks$path", ({ method, path, handler, body }) => {
  it.each([
    { credential: "valid read-only token", status: 403 },
    { credential: "unrelated scope", status: 403 },
    { credential: "expired token", status: 401 },
    { credential: "invalid token", status: 401 },
    { credential: "missing authentication", status: 401 },
  ])("returns $status for $credential before task data access", async ({ credential, status }) => {
    if (credential === "expired token") boundary.token.mockResolvedValue({ id: "token", user: { id: "actor" }, scopes: [], expiresAt: new Date(0) });
    if (credential === "unrelated scope") boundary.token.mockResolvedValue({ id: "token", user: { id: "actor" }, scopes: ["board.create"], expiresAt: null });
    const authorization: Record<string, string> = credential === "missing authentication" ? {} : {
      authorization: `Bearer ${credential === "invalid token" ? "invalid" : secret}`,
    };
    const request = new NextRequest(`http://localhost/api/tasks${path}`, {
      method, headers: { "content-type": "application/json", ...authorization }, body: JSON.stringify(body ?? {}),
    });
    const response = await handler(request, context);
    expect(response.status).toBe(status);
    expect(boundary.used).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain(secret);
  });
});
