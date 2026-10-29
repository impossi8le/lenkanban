import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ actor: vi.fn(), key: vi.fn(), limit: vi.fn(), save: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: f.actor, UnauthorizedError: class UnauthorizedError extends Error {} }));
vi.mock("@/lib/telemetry/store", () => ({ telemetryActorKey: f.key, consumeTelemetryRateLimits: f.limit }));
vi.mock("@/lib/problem-report-comment-store", async () => ({ ...await vi.importActual<typeof import("@/lib/problem-report-comment-store")>("@/lib/problem-report-comment-store"), saveProblemReportComment: f.save }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/middleware/api-logger", () => ({ withApiLogging: (request: Request, handler: (r: Request, c: object) => unknown) => handler(request, {}) }));
import { UnauthorizedError } from "@/lib/require-api-user";
import { ProblemReportCommentError } from "@/lib/problem-report-comment-store";
import { POST } from "./route";
const reportId = "11111111-1111-4111-8111-111111111111";
const params = { params: Promise.resolve({ reportId }) };
function request(body: unknown = { comment: "Я вернулся на главную" }, origin = "https://app.test") {
  return new Request(`https://app.test/api/problem-reports/${reportId}/comment`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify(body) });
}
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("TELEMETRY_ENABLED", "true"); vi.stubEnv("TELEMETRY_HMAC_SECRET", "synthetic-secret-of-at-least-32-characters"); vi.stubEnv("APP_URL", "https://app.test"); vi.stubEnv("NEXTAUTH_URL", "https://app.test");
  f.actor.mockResolvedValue({ id: "employee", globalRole: "USER" }); f.key.mockReturnValue("server-actor-key"); f.save.mockResolvedValue({ reportId });
});
afterEach(() => vi.unstubAllEnvs());
it("allows an authenticated employee to save only their explicit comment, returning no text", async () => {
  const response = await POST(request(), params);
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(f.key).toHaveBeenCalledWith("employee");
  expect(f.save).toHaveBeenCalledWith("server-actor-key", reportId, "Я вернулся на главную");
  expect(await response.json()).toMatchObject({ data: { reportId } });
});
it("rejects unauthenticated or cross-origin requests before saving", async () => {
  f.actor.mockRejectedValueOnce(new UnauthorizedError()); expect((await POST(request(), params)).status).toBe(401);
  expect((await POST(request(undefined, "https://foreign.test"), params)).status).toBe(403);
  expect(f.save).not.toHaveBeenCalled();
});
it("rejects oversize, empty, extra-field and malformed-ID requests", async () => {
  for (const body of [{ comment: "x".repeat(2001) }, { comment: " " }, { comment: "ok", cookie: "secret" }]) expect((await POST(request(body), params)).status).toBe(400);
  expect((await POST(request(), { params: Promise.resolve({ reportId: "invalid" }) })).status).toBe(400);
  expect(f.save).not.toHaveBeenCalled();
});
it.each([404, 409, 503])("preserves safe store status %s without returning body, query or cause", async status => {
  f.save.mockRejectedValue(new ProblemReportCommentError(status, status === 404 ? "PROBLEM_REPORT_NOT_FOUND" : status === 409 ? "PROBLEM_REPORT_COMMENT_CONFLICT" : "PROBLEM_REPORT_COMMENT_UNAVAILABLE"));
  const response = await POST(request({ comment: "synthetic-secret" }), params);
  expect(response.status).toBe(status); expect(JSON.stringify(await response.json())).not.toContain("synthetic-secret");
});
