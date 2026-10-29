import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), query: vi.fn(), list: vi.fn(), where: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: mocks.query, task: { findMany: mocks.list } } }));
vi.mock("@/lib/require-api-user", async () => ({ requireApiUser: mocks.auth,
  UnauthorizedError: (await import("@/lib/errors")).UnauthorizedError }));
vi.mock("@/lib/project-access", () => ({ getTaskReadWhere: mocks.where, getProjectCreateAccess: vi.fn() }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: mocks.log } }));
vi.mock("@/socket/board-events", () => ({ emitTaskCreated: vi.fn() }));
vi.mock("@/lib/automation-processor", () => ({ processAutomationRules: vi.fn() }));
import { GET } from "./route";
import { UnauthorizedError } from "@/lib/errors";

const input = () => new Request("http://localhost/api/tasks?search=synthetic-private-search", {
  headers: { "x-user-id": "forged-user", "x-forwarded-for": "203.0.113.8" },
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ id: "actor", globalRole: "USER" });
  mocks.query.mockResolvedValue([{ count: 1 }]);
  mocks.where.mockResolvedValue({}); mocks.list.mockResolvedValue([]);
});
function noTaskQuery() { expect(mocks.where).not.toHaveBeenCalled(); expect(mocks.list).not.toHaveBeenCalled(); }

describe("GET tasks authenticated shared quota", () => {
  it("uses only authenticated actor identity in the shared admission key", async () => {
    expect((await GET(input())).status).toBe(200);
    expect(mocks.query).toHaveBeenCalledOnce();
    const values = mocks.query.mock.calls[0].slice(1);
    expect(values[0]).toBe("tasks:list:actor");
    expect(values).toContain(120);
    expect(JSON.stringify(values)).not.toMatch(/synthetic-private-search|forged-user|203\.0\.113/);
  });

  it("admits 120 ordinary reads and denies the next before task access, independently for another actor", async () => {
    const counts = new Map<string, number>();
    mocks.query.mockImplementation(async (_sql, key: string, ...values: unknown[]) => {
      const limit = values.find(value => typeof value === "number") as number;
      const count = counts.get(key) ?? 0;
      if (count >= limit) return [];
      counts.set(key, count + 1); return [{ count: count + 1 }];
    });
    for (let index = 0; index < 120; index++) expect((await GET(input())).status).toBe(200);
    expect(mocks.where).toHaveBeenCalledTimes(120);
    expect(mocks.list).toHaveBeenCalledTimes(240);
    const denied = await GET(input());
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBe("60");
    expect(await denied.json()).toEqual({ error: "RateLimited", retryAfter: 60 });
    expect(mocks.list).toHaveBeenCalledTimes(240);
    expect(mocks.where).toHaveBeenCalledTimes(120);
    expect(counts.get("tasks:list:actor")).toBe(120);
    mocks.auth.mockResolvedValue({ id: "other-actor", globalRole: "ADMIN" });
    expect((await GET(input())).status).toBe(200);
    expect(counts.get("tasks:list:other-actor")).toBe(1);
    expect(mocks.list).toHaveBeenCalledTimes(242);
    expect(mocks.where).toHaveBeenCalledTimes(121);
  });

  it("rejects exhausted admission before policy lookup and data queries", async () => {
    mocks.query.mockResolvedValue([]);
    const response = await GET(input());
    expect(response.status).toBe(429); noTaskQuery();
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it("fails closed with safe 500 rather than 429 for an unrelated limiter failure", async () => {
    mocks.query.mockRejectedValue(new Error("synthetic-private-search synthetic-provider-secret"));
    const response = await GET(input());
    expect(response.status).toBe(500); noTaskQuery();
    expect(response.headers.has("Retry-After")).toBe(false);
    expect(await response.text()).not.toMatch(/synthetic-private|synthetic-provider/);
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it("requires authentication before consuming quota", async () => {
    mocks.auth.mockRejectedValue(new UnauthorizedError());
    expect((await GET(input())).status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled(); noTaskQuery();
  });
});
