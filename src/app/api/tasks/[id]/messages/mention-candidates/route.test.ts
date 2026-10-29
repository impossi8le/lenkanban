import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn(), users: vi.fn(), filter: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: async () => undefined, rateLimitErrorResponse: () => new Response(null, { status: 429 }) }));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findMany: api.users } } }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: api.auth, UnauthorizedError: class UnauthorizedError extends Error {} }));
vi.mock("@/lib/project-access", () => ({ requireTaskRead: api.read }));
vi.mock("@/lib/task-mentions", () => ({ filterMentionReaders: api.filter }));
import { GET } from "./route";
import { NotFoundError } from "@/lib/errors";
import { UnauthorizedError } from "@/lib/require-api-user";
const run = (query = "") => GET(new Request(`http://localhost/api/tasks/task/messages/mention-candidates${query}`), { params: Promise.resolve({ id: "task" }) });
beforeEach(() => { vi.resetAllMocks(); api.auth.mockResolvedValue({ id: "actor", globalRole: "USER" }); api.read.mockResolvedValue({ id: "task", projectId: "board" }); api.users.mockResolvedValue([{ id: "selected", name: "Анна", primaryDepartment: { name: "Отдел" }, email: "private-email" }, { id: "hidden", name: "Скрытый" }]); api.filter.mockResolvedValue(["selected"]); });
describe("scoped mention candidate API", () => {
  it("requires authentication and current task read before searching people", async () => {
    api.auth.mockRejectedValueOnce(new UnauthorizedError()); expect((await run()).status).toBe(401);
    api.read.mockRejectedValueOnce(new NotFoundError()); expect((await run()).status).toBe(404); expect(api.users).not.toHaveBeenCalled();
  });
  it("searches only names with a fixed bound and returns only safe names of current readers", async () => {
    const response = await run("?search=%D0%90%D0%BD%D0%BD"); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ data: { items: [{ id: "selected", name: "Анна", departmentName: "Отдел" }] } });
    expect(api.users).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { not: "actor" }, isBlocked: false, blockedAt: null, name: { contains: "Анн", mode: "insensitive" } }, take: 40 }));
    const json = JSON.stringify(await (await run()).json()); expect(json).not.toMatch(/email|private-email|hidden|Скрытый/);
  });
  it("returns an indistinguishable empty list for no eligible matches", async () => { api.filter.mockResolvedValue([]); expect(await (await run()).json()).toMatchObject({ data: { items: [] } }); });
  it("caps output at twenty after current ACL filtering", async () => { api.users.mockResolvedValue(Array.from({ length: 40 }, (_, id) => ({ id: `user${id}`, name: `User${id}` }))); api.filter.mockResolvedValue(Array.from({ length: 40 }, (_, id) => `user${id}`)); expect((await (await run()).json()).data.items).toHaveLength(20); });
  it("rejects unsupported internal mentions without exposing candidate data", async () => { expect((await run("?visibility=INTERNAL")).status).toBe(422); expect(api.users).not.toHaveBeenCalled(); });
});
