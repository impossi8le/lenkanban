import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), findMany: vi.fn() }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: mocks.user }));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findMany: mocks.findMany } } }));

import { GET } from "./route";

const publicUser = {
  id: "candidate", email: "candidate@example.invalid", name: "Candidate", avatarUrl: null,
};

describe("authenticated people picker", () => {
  beforeEach(() => {
    mocks.user.mockReset().mockResolvedValue({ id: "viewer", globalRole: "USER" });
    mocks.findMany.mockReset().mockResolvedValue([publicUser]);
  });

  it.each(["USER", "ADMIN"])("omits administrative and unexpected fields for %s", async (role) => {
    mocks.user.mockResolvedValue({ id: "viewer", globalRole: role });
    mocks.findMany.mockResolvedValue([{ ...publicUser, globalRole: "ADMIN", password: "synthetic-secret", primaryDepartmentId: "private" }]);
    const response = await GET(new Request("https://app.test/api/users"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: [publicUser] });
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: role === "ADMIN" ? undefined : {
        OR: [
          { id: "viewer" },
          { projectMemberships: { some: { project: { OR: [
            { ownerId: "viewer" }, { members: { some: { userId: "viewer" } } },
          ] } } } },
          { projects: { some: { OR: [
            { ownerId: "viewer" }, { members: { some: { userId: "viewer" } } },
          ] } } },
        ],
      },
      select: { id: true, email: true, name: true, avatarUrl: true },
      take: 20, orderBy: { email: "asc" },
    });
  });

  it("rejects unauthenticated requests before querying candidates", async () => {
    mocks.user.mockRejectedValue(new Error("Unauthorized"));
    const response = await GET(new Request("https://app.test/api/users"));
    expect(response.status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it.each(["0", "101", "not-a-number"])("rejects invalid take=%s before querying", async (take) => {
    const response = await GET(new Request(`https://app.test/api/users?take=${take}`));
    expect(response.status).toBe(422);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("retains global candidate search with bounded results", async () => {
    mocks.user.mockResolvedValue({ id: "viewer", globalRole: "ADMIN" });
    const response = await GET(new Request("https://app.test/api/users?q=Candidate&take=5"));
    expect(response.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [
        { email: { contains: "Candidate", mode: "insensitive" } },
        { name: { contains: "Candidate", mode: "insensitive" } },
      ] }, take: 5,
    }));
  });

  it("does not return database errors or candidate data on failure", async () => {
    mocks.findMany.mockRejectedValue(new Error("synthetic-secret"));
    const response = await GET(new Request("https://app.test/api/users"));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("synthetic-secret");
  });
});

// Evaluate the emitted query against related fixture rows, rather than returning
// pre-filtered candidates. These are route contract tests, not database tests.
type Row = Record<string, unknown>;
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Row[]).some(part => matches(row, part));
    if (key === "AND") return (condition as Row[]).every(part => matches(row, part));
    const value = row[key];
    if (condition !== null && typeof condition === "object") {
      const filter = condition as Row;
      if ("some" in filter) return Array.isArray(value) && value.some(item => matches(item, filter.some as Row));
      if ("contains" in filter) {
        return typeof value === "string" && value.toLowerCase().includes(String(filter.contains).toLowerCase());
      }
      return value !== null && typeof value === "object" && matches(value as Row, filter);
    }
    return value === condition;
  });
}

describe("people picker access boundary", () => {
  const project = (ownerId: string, ...userIds: string[]) => ({
    ownerId, members: userIds.map(userId => ({ userId })),
  });
  let shared: ReturnType<typeof project>;
  let owned: ReturnType<typeof project>;
  const unrelated = project("stranger", "other-member");
  const person = (id: string, memberships: Row[] = [], projects: Row[] = []) => ({
    id, email: `${id}@example.invalid`, name: id, avatarUrl: null, globalRole: "USER",
    projectMemberships: memberships.map(project => ({ project })), projects,
  });
  let rows: ReturnType<typeof person>[];

  beforeEach(() => {
    mocks.user.mockReset().mockResolvedValue({ id: "viewer", globalRole: "USER" });
    shared = project("owner", "viewer", "co-member");
    owned = project("viewer", "owned-member");
    rows = [
      person("viewer", [shared], [owned]), person("co-member", [shared]),
      person("owner", [], [shared]), person("owned-member", [owned]),
      person("stranger", [], [unrelated]), person("other-member", [unrelated]),
    ];
    mocks.findMany.mockReset().mockImplementation(async ({ where, take, select }) => rows
      .filter(row => matches(row, where))
      .sort((a, b) => a.email.localeCompare(b.email))
      .slice(0, take)
      .map(row => Object.fromEntries(Object.keys(select).map(key => [key, row[key as keyof typeof row]]))));
  });

  async function directory(query = "") {
    const response = await GET(new Request(`https://app.test/api/users${query}`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    for (const user of body.data) {
      expect(user).not.toHaveProperty("globalRole");
      expect(Object.keys(user).sort()).toEqual(["avatarUrl", "email", "id", "name"]);
    }
    return body.data as { id: string; email: string }[];
  }

  it("does not expose a stranger's email to a caller without any projects", async () => {
    rows[0] = person("viewer");
    shared.members = shared.members.filter(member => member.userId !== "viewer");
    owned.ownerId = "stranger";
    const users = await directory();
    expect(users.map(user => user.id)).toEqual(["viewer"]);
    expect(users.map(user => user.email)).not.toContain("stranger@example.invalid");
  });

  it("includes co-members, project owners and members of caller-owned projects only", async () => {
    expect((await directory()).map(user => user.id)).toEqual(["co-member", "owned-member", "owner", "viewer"]);
  });

  it("includes the caller even when they have no project membership rows", async () => {
    rows[0] = person("viewer", [], [owned]);
    shared.members = shared.members.filter(member => member.userId !== "viewer");
    expect((await directory()).map(user => user.id)).toEqual(["owned-member", "viewer"]);
  });

  it("allows ADMIN to see the full catalog without exposing globalRole", async () => {
    mocks.user.mockResolvedValue({ id: "viewer", globalRole: "ADMIN" });
    expect((await directory()).map(user => user.id)).toEqual([
      "co-member", "other-member", "owned-member", "owner", "stranger", "viewer",
    ]);
  });

  it("does not let an exact stranger email search bypass the access boundary", async () => {
    expect(await directory("?q=stranger%40example.invalid&take=1")).toEqual([]);
  });

  it("keeps case-insensitive search and take inside the allowed circle", async () => {
    expect((await directory("?q=MEMBER&take=1")).map(user => user.id)).toEqual(["co-member"]);
    expect((await directory("?q=VIEWER")).map(user => user.id)).toEqual(["viewer"]);
  });
});
