import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), rateLimit: vi.fn(), log: vi.fn(), template: vi.fn(), create: vi.fn(), transaction: vi.fn(), department: vi.fn(),
  audited: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  projectTemplate: { findUnique: mocks.template }, project: { create: mocks.create }, $transaction: mocks.transaction,
  department: { findUnique: mocks.department },
} }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: mocks.auth, UnauthorizedError: class UnauthorizedError extends Error {} }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: mocks.log } }));
vi.mock("@/lib/nextauth", () => ({ nextAuthOptions: {} }));
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));
vi.mock("../projects/board-creation", async original => ({
  ...await original<typeof import("../projects/board-creation")>(), createAuditedBoard: mocks.audited,
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/rate-limit")>(), rateLimitOrThrowKey: mocks.rateLimit,
}));

import { UnauthorizedError } from "@/lib/require-api-user";
import { POST as applyTemplate } from "./[id]/use/route";
import { POST as createProject } from "../projects/route";

function request(body: unknown = { projectName: "Project" }) {
  return new Request("http://localhost/api/project-templates/template-1/use", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
const params = () => ({ params: Promise.resolve({ id: "template-1" }) });
const apply = (body?: unknown) => applyTemplate(request(body), params());

beforeEach(() => {
  vi.resetAllMocks();
  // Creation admission tests require an authorized global administrator.
  mocks.auth.mockResolvedValue({ id: "actor-1", globalRole: "ADMIN" });
  mocks.template.mockResolvedValue({ id: "template-1", createdById: "actor-1", templateData: { columns: [], tags: [] } });
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.department.mockResolvedValue({ parentId: null, archivedAt: null });
  mocks.create.mockResolvedValue({ id: "project-new" });
  mocks.audited.mockResolvedValue({ id: "plain-project" });
  mocks.transaction.mockResolvedValue({ id: "plain-project" });
});

describe("template project creation shares the existing actor quota", () => {
  it("uses the same key and authenticated actor as ordinary project creation", async () => {
    expect((await createProject(request({ name: "Plain project", departmentId: "dep-1" }))).status).toBe(201);
    expect((await apply({ projectName: "From template", actorId: "spoofed", ownerId: "spoofed", userId: "spoofed" })).status).toBe(201);
    expect(mocks.rateLimit.mock.calls).toEqual([["projects:create", "actor-1"], ["projects:create", "actor-1"]]);
    expect(mocks.audited).toHaveBeenCalledOnce();
    expect(mocks.audited.mock.calls[0][0].actorId).toBe("actor-1");
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[0][0].data.ownerId).toBe("actor-1");
  });

  it("preserves a real quota denial response and Retry-After without writing", async () => {
    mocks.rateLimit.mockRejectedValue({ status: 429, retryAfterSec: 17 });
    const response = await apply();
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("17");
    expect(await response.json()).toEqual({ error: "RateLimited", retryAfter: 17 });
    expect(mocks.rateLimit).toHaveBeenCalledExactlyOnceWith("projects:create", "actor-1");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("does not let administrators bypass the quota", async () => {
    mocks.auth.mockResolvedValue({ id: "admin-1", globalRole: "ADMIN" });
    mocks.template.mockResolvedValue({ id: "template-1", createdById: "other-creator",
      templateData: { columns: [], tags: [], availability: "organization" } });
    mocks.rateLimit.mockRejectedValue({ status: 429, retryAfterSec: 17 });
    expect((await apply()).status).toBe(429);
    expect(mocks.rateLimit).toHaveBeenCalledExactlyOnceWith("projects:create", "admin-1");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("returns a safe 500 for an unexpected limiter failure", async () => {
    mocks.rateLimit.mockRejectedValue(new Error("synthetic-private-sentinel", { cause: { body: "synthetic-private-sentinel" } }));
    const response = await apply();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("synthetic-private-sentinel");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.log.mock.calls).toEqual([[{ event: "project.template.use.failed", route: "/api/project-templates/:id/use" }]]);
  });

  it("awaits quota admission before starting nested project creation", async () => {
    let admit!: () => void;
    let started!: () => void;
    const atLimiter = new Promise<void>((resolve) => { started = resolve; });
    mocks.rateLimit.mockImplementation(() => {
      const admission = new Promise<void>((resolve) => { admit = resolve; });
      started();
      return admission;
    });
    const result = apply();
    await atLimiter;
    expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
    expect(mocks.create).not.toHaveBeenCalled();
    admit();
    expect((await result).status).toBe(201);
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});

describe("template admission is checked after access and validation", () => {
  it("does not consume quota for unauthenticated requests", async () => {
    mocks.auth.mockRejectedValue(new UnauthorizedError());
    expect((await apply()).status).toBe(401);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("does not consume quota for an inaccessible template", async () => {
    mocks.auth.mockResolvedValue({ id: "actor-1", globalRole: "USER" });
    mocks.template.mockResolvedValue({ createdById: "other", templateData: {} });
    expect((await apply()).status).toBe(403);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("does not consume quota for a missing template", async () => {
    mocks.template.mockResolvedValue(null);
    expect((await apply()).status).toBe(404);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { projectName: "" }].map((body, index) => ({ body, index })))("does not consume quota for invalid body case $index", async ({ body }) => {
    expect((await apply(body)).status).toBe(400);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("does not consume quota for malformed JSON", async () => {
    const response = await applyTemplate(new Request("http://localhost/api/project-templates/template-1/use", { method: "POST", body: "{" }), params());
    expect(response.status).toBe(400);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([null, { columns: "invalid" }, { columns: [
    { name: "One", color: "#fff", position: 0 }, { name: "Two", color: "#fff", position: 0 },
  ] }].map((templateData, index) => ({ templateData, index })))("does not consume quota for invalid stored data case $index", async ({ templateData }) => {
    mocks.template.mockResolvedValue({ createdById: "actor-1", templateData });
    expect((await apply()).status).toBe(400);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
