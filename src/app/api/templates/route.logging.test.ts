import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "@/lib/errors";

const fixture = vi.hoisted(() => ({
  auth: vi.fn(), project: vi.fn(), list: vi.fn(), create: vi.fn(), diagnostic: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { project: { findFirst: fixture.project }, taskTemplate: { findMany: fixture.list, create: fixture.create } } }));
vi.mock("@/lib/require-api-user", async () => ({ requireApiUser: fixture.auth, UnauthorizedError: (await import("@/lib/errors")).UnauthorizedError }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: fixture.diagnostic } }));
import { GET, POST } from "./route";

const secret = "synthetic-template-private-value";
function request(method: "GET" | "POST") {
  return new Request(`http://localhost/api/templates?projectId=${secret}`, { method,
    ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: secret, name: secret, templateTitle: secret, tags: [{ private: secret }] }) } : {}) });
}
function privateError() {
  return Object.assign(new Error(secret, { cause: { token: secret, body: { nested: [secret] } } }), { request: { query: secret, cookie: secret } });
}
let rawConsole: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  fixture.auth.mockResolvedValue({ id: "synthetic-actor", globalRole: "MEMBER" });
  fixture.project.mockResolvedValue({ id: "synthetic-project" });
  fixture.list.mockRejectedValue(privateError()); fixture.create.mockRejectedValue(privateError());
  fixture.diagnostic.mockImplementation(() => undefined);
  rawConsole = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("template collection failure diagnostics", () => {
  it.each(["GET", "POST"] as const)("%s retains safe500 and passes only constant metadata", async method => {
    const response = await (method === "GET" ? GET : POST)(request(method));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ success: false, error: { code: "INTERNAL_ERROR", message: method === "GET" ? "Failed to fetch templates" : "Failed to create template" } });
    expect(fixture.diagnostic.mock.calls.length).toBe(1);
    expect(fixture.diagnostic).toHaveBeenCalledWith({ event: "api.request.failed", route: "/api/templates", method, statusCode: 500 });
    expect(rawConsole.mock.calls.length).toBe(0);
    expect(JSON.stringify(fixture.diagnostic.mock.calls)).not.toContain(secret);
  });
  it.each(["GET", "POST"] as const)("%s preserves safe500 when the diagnostic sink throws", async method => {
    fixture.diagnostic.mockImplementation(() => { throw privateError(); });
    const response = await (method === "GET" ? GET : POST)(request(method));
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload).toEqual({ success: false, error: { code: "INTERNAL_ERROR", message: method === "GET" ? "Failed to fetch templates" : "Failed to create template" } });
    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(rawConsole.mock.calls.length).toBe(0);
    expect(fixture.diagnostic.mock.calls.length).toBe(1);
    expect(fixture.diagnostic).toHaveBeenCalledWith({ event: "api.request.failed", route: "/api/templates", method, statusCode: 500 });
    expect(JSON.stringify(fixture.diagnostic.mock.calls)).not.toContain(secret);
  });
  it.each(["GET", "POST"] as const)("%s leaves unauthorized401 unlogged", async method => {
    fixture.auth.mockRejectedValue(new UnauthorizedError());
    const response = await (method === "GET" ? GET : POST)(request(method));
    expect(response.status).toBe(401); expect(fixture.diagnostic.mock.calls.length).toBe(0); expect(rawConsole.mock.calls.length).toBe(0);
  });
  it("invalid POST JSON retains400 without error diagnostics or database access", async () => {
    const response = await POST(new Request("http://localhost/api/templates", { method: "POST", body: "{" }));
    expect(response.status).toBe(400); expect(fixture.auth.mock.calls.length).toBe(0); expect(fixture.create.mock.calls.length).toBe(0);
    expect(fixture.diagnostic.mock.calls.length).toBe(0); expect(rawConsole.mock.calls.length).toBe(0);
  });
});
