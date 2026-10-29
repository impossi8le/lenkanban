import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUniqueToken: vi.fn(),
  updateToken: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    apiToken: { findUnique: mocks.findUniqueToken, update: mocks.updateToken },
    $queryRaw: mocks.queryRaw,
  },
}));
vi.mock("@/lib/api-tokens", () => ({
  parseApiToken: (token: string) => (token === "valid-token" ? { id: "token-1" } : null),
  hashApiToken: () => "hashed-token",
}));
vi.mock("@/lib/require-user", () => ({ requireDbUser: vi.fn() }));

import { getApiUser } from "./require-api-user";
import { resetRevocationColumnProbe } from "./auth";

function bearer() {
  return new Request("https://app.test/api/tasks", { headers: { authorization: "Bearer valid-token" } });
}

beforeEach(() => {
  vi.resetAllMocks();
  resetRevocationColumnProbe();
  mocks.updateToken.mockResolvedValue({});
  mocks.queryRaw.mockResolvedValue([{ blocked: false }]);
});

describe("bearer authentication and revocation", () => {
  it("returns the token owner while the account is active", async () => {
    mocks.findUniqueToken.mockResolvedValue({ id: "token-1", revokedAt: null, user: { id: "user-1" } });
    await expect(getApiUser(bearer())).resolves.toMatchObject({ id: "user-1" });
  });

  it("rejects a revoked token", async () => {
    mocks.findUniqueToken.mockResolvedValue({ id: "token-1", revokedAt: new Date(), user: { id: "user-1" } });
    await expect(getApiUser(bearer())).resolves.toBeNull();
  });

  it("rejects a valid token whose account is blocked", async () => {
    mocks.findUniqueToken.mockResolvedValue({ id: "token-1", revokedAt: null, user: { id: "user-1" } });
    mocks.queryRaw.mockResolvedValue([{ blocked: true }]);
    await expect(getApiUser(bearer())).resolves.toBeNull();
    expect(mocks.updateToken).not.toHaveBeenCalled();
  });

  it("does not treat a malformed token as authenticated", async () => {
    const request = new Request("https://app.test/api/tasks", { headers: { authorization: "Bearer nope" } });
    await expect(getApiUser(request)).resolves.toBeNull();
    expect(mocks.findUniqueToken).not.toHaveBeenCalled();
  });
});
