import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ token: vi.fn(), used: vi.fn(), session: vi.fn(), allowed: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { apiToken: { findUnique: mocks.token, update: mocks.used } } }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: mocks.session }));
vi.mock("@/lib/auth", () => ({ isAccountAllowed: mocks.allowed }));
import { generateApiToken, type ApiTokenScope } from "./api-tokens";
import { requireApiUser } from "./require-api-user";
import { ForbiddenError, UnauthorizedError } from "./errors";

const user = { id: "actor", globalRole: "ADMIN" };
const secret = generateApiToken().token;
const request = (path = "/api/tasks", method = "POST", bearer = true) => new Request(`http://localhost${path}`, {
  method, headers: bearer ? { authorization: `Bearer ${secret}` } : {},
});
beforeEach(() => {
  vi.resetAllMocks(); mocks.allowed.mockResolvedValue(true); mocks.used.mockResolvedValue({});
  mocks.session.mockResolvedValue(user);
  mocks.token.mockResolvedValue({ id: "token", user, scopes: [], expiresAt: null, revokedAt: null });
});

describe("bearer scopes and expiry", () => {
  it.each([new Date(0), new Date(Date.now() - 1000)])("rejects expired credentials before scope checks", async expiresAt => {
    mocks.token.mockResolvedValue({ id: "token", user, scopes: ["request.create"], expiresAt, revokedAt: null });
    await expect(requireApiUser(request())).rejects.toBeInstanceOf(UnauthorizedError);
    expect(mocks.used).not.toHaveBeenCalled(); expect(mocks.session).not.toHaveBeenCalled();
  });
  it("keeps empty scopes read-only", async () => {
    await expect(requireApiUser(request())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireApiUser(request("/api/tasks", "GET"))).resolves.toEqual(user);
  });
  it.each([
    ["/api/tasks", "POST", "request.create"],
    ["/api/tasks/task", "PATCH", "request.update"],
    ["/api/tasks/task/move", "POST", "request.move"],
    ["/api/tasks/task/messages", "POST", "request.comment"],
    ["/api/projects", "POST", "board.create"],
  ] as const)("requires the matching scope for %s %s", async (path, method, scope) => {
    mocks.token.mockResolvedValueOnce({ id: "token", user, scopes: ["unrelated"], expiresAt: null, revokedAt: null });
    await expect(requireApiUser(request(path, method))).rejects.toBeInstanceOf(ForbiddenError);
    mocks.token.mockResolvedValueOnce({ id: "token", user, scopes: [scope], expiresAt: new Date("2030-01-01"), revokedAt: null });
    await expect(requireApiUser(request(path, method))).resolves.toEqual(user);
  });
  it("leaves session writes unrestricted by token scopes", async () => {
    await expect(requireApiUser(request("/api/tasks", "POST", false))).resolves.toEqual(user);
    expect(mocks.token).not.toHaveBeenCalled();
  });
  it("fails closed on unknown mutation routes", async () => {
    mocks.token.mockResolvedValue({ id: "token", user, scopes: ["request.update"], expiresAt: null });
    await expect(requireApiUser(request("/api/unknown"))).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("checks every explicitly required scope", async () => {
    const scopes: ApiTokenScope[] = ["request.update", "request.move"];
    mocks.token.mockResolvedValue({ id: "token", user, scopes: ["request.update"], expiresAt: null });
    await expect(requireApiUser(request(), scopes)).rejects.toBeInstanceOf(ForbiddenError);
  });
  it.each([
    { body: { columnId: "target" }, scopes: ["request.move"], allowed: true },
    { body: { columnId: "target" }, scopes: ["request.update"], allowed: false },
    { body: { columnId: "target", title: "Title" }, scopes: ["request.move"], allowed: false },
    { body: { columnId: "target", title: "Title" }, scopes: ["request.move", "request.update"], allowed: true },
  ])("checks relocation and scalar scopes in legacy PATCH: %j", async ({ body, scopes, allowed }) => {
    mocks.token.mockResolvedValue({ id: "token", user, scopes, expiresAt: null });
    const input = new Request("http://localhost/api/tasks/task", { method: "PATCH",
      headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
    const result = requireApiUser(input);
    if (allowed) await expect(result).resolves.toEqual(user);
    else await expect(result).rejects.toBeInstanceOf(ForbiddenError);
    expect(await input.json()).toEqual(body);
  });
});
