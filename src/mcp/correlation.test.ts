import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, apiSuccess } from "@/lib/api-response";
import { createMcpServer } from "./server";
import { createCanonicalPort } from "./local-port";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), access: vi.fn(), get: vi.fn(), patch: vi.fn(),
  info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: mocks.authenticate }));
vi.mock("@/lib/project-access", () => ({ getProjectAccess: mocks.access }));
vi.mock("@/app/api/tasks/[id]/route", () => ({ GET: mocks.get, PATCH: mocks.patch }));
vi.mock("@/lib/logger", () => ({ apiLogger: { info: mocks.info, warn: mocks.warn, error: mocks.error } }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({ id: "actor", globalRole: "USER" });
  mocks.access.mockResolvedValue({ canRead: true });
  mocks.get.mockResolvedValue(apiSuccess({ projectId: "board" }));
  mocks.patch.mockResolvedValue(apiError("STALE_TASK_VERSION", "private", undefined, 409));
});

describe("MCP to canonical HTTP correlation", () => {
  it.each([undefined, "invalid-secret", "e38cfd31-d651-4a9b-a7eb-13fb1a9d7312"])("links readers, command and MCP diagnostics with actionId %s", async action => {
    const diagnose = vi.fn();
    const response = await createMcpServer({ port: createCanonicalPort(), diagnose }).handle(new Request("http://localhost/mcp", {
      method: "POST", headers: { authorization: `Bearer kb2_123456789abc_${"a".repeat(43)}`,
        "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18", ...(action ? { "x-action-id": action } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "update_task",
        arguments: { taskId: "task", expectedVersion: 1, operationId: "917ece49-003b-4f57-acb3-3ea285f4d0a9", changes: { title: "private" } } } }),
    }));
    const requestId = response.headers.get("x-request-id");
    const expectedAction = action?.startsWith("e38") ? action : requestId;
    expect(response.headers.get("x-action-id")).toBe(expectedAction);
    const authRequest = mocks.authenticate.mock.calls[0][0] as Request;
    expect(authRequest.headers.get("x-request-id")).toBe(requestId);
    expect(authRequest.headers.get("x-action-id")).toBe(expectedAction);
    expect((await response.json()).result.structuredContent.error.code).toBe("STALE_VERSION");
    for (const mock of [mocks.get, mocks.patch]) {
      expect(mock).toHaveBeenCalledTimes(1);
      expect(mock.mock.calls[0][0].headers.get("x-action-id")).toBe(expectedAction);
    }
    const logs = [...mocks.info.mock.calls, ...mocks.warn.mock.calls].map(call => call[0]);
    expect(logs).toHaveLength(2);
    for (const log of logs) {
      expect(log.actionId).toBe(expectedAction);
      expect(log.requestId).not.toBe(requestId);
      expect(log.actorId).toBe("actor");
    }
    expect(diagnose).toHaveBeenCalledWith(expect.objectContaining({ requestId, actionId: expectedAction }));
    expect(JSON.stringify([logs, diagnose.mock.calls])).not.toContain("private");
    expect(JSON.stringify([logs, diagnose.mock.calls])).not.toContain("invalid-secret");
  });
});
