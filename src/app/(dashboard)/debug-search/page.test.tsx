import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireDbUser: vi.fn(),
  notFound: vi.fn(),
  sentinel: new Error("NEXT_NOT_FOUND_TEST"),
  findUnique: vi.fn(),
  create: vi.fn(), update: vi.fn(), delete: vi.fn(),
}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/require-user", () => ({
  requireDbUser: mocks.requireDbUser,
  isGlobalAdmin: (user: { globalRole?: string }) => user.globalRole === "ADMIN",
}));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findUnique: mocks.findUnique }, task: {
  create: mocks.create, update: mocks.update, delete: mocks.delete,
} } }));
vi.mock("./DebugSearchClient", () => ({ default: function DiagnosticClientStub() { return null; } }));

import DebugSearchPage, { dynamic } from "./page";
import DebugSearchClient from "./DebugSearchClient";

function assertNoDirectDataAccess() {
  expect(mocks.findUnique).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.delete).not.toHaveBeenCalled();
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "development");
  mocks.notFound.mockImplementation(() => { throw mocks.sentinel; });
  mocks.requireDbUser.mockResolvedValue({ id: "admin-1", globalRole: "ADMIN" });
});
afterEach(() => vi.unstubAllEnvs());

describe("debug search server page", () => {
  it.each(["production", "test", "staging", ""])("hides page in %j before authentication or database access", async (environment) => {
    vi.stubEnv("NODE_ENV", environment);
    await expect(DebugSearchPage()).rejects.toBe(mocks.sentinel);
    expect(mocks.notFound).toHaveBeenCalledOnce();
    expect(mocks.requireDbUser).not.toHaveBeenCalled();
    assertNoDirectDataAccess();
  });

  it("hides the development page from anonymous users", async () => {
    mocks.requireDbUser.mockRejectedValue(Error("Unauthenticated"));
    await expect(DebugSearchPage()).rejects.toBe(mocks.sentinel);
    expect(mocks.requireDbUser).toHaveBeenCalledOnce();
    expect(mocks.notFound).toHaveBeenCalledOnce();
    assertNoDirectDataAccess();
  });

  it.each(["USER", "DEPARTMENT_ADMIN"])("hides the development page from %s", async (globalRole) => {
    mocks.requireDbUser.mockResolvedValue({ id: "user-1", globalRole });
    await expect(DebugSearchPage()).rejects.toBe(mocks.sentinel);
    expect(mocks.notFound).toHaveBeenCalledOnce();
    assertNoDirectDataAccess();
  });

  it("renders only the stub client for an authenticated development global admin", async () => {
    const result = await DebugSearchPage();
    expect(result.type).toBe(DebugSearchClient);
    expect(mocks.requireDbUser).toHaveBeenCalledOnce();
    expect(mocks.notFound).not.toHaveBeenCalled();
    expect(dynamic).toBe("force-dynamic");
    assertNoDirectDataAccess();
  });
});
