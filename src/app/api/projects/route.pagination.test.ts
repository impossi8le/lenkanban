import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), findMany: vi.fn(), readWhere: vi.fn(), log: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: { project: { findMany: mocks.findMany } } }));
vi.mock("@/lib/project-access", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/project-access")>(), getTaskReadWhere: mocks.readWhere }));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: mocks.auth,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: mocks.log } }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: vi.fn(), rateLimitErrorResponse: vi.fn() }));
// Keep require-user/isGlobalAdmin real; isolate only its unused session dependencies.
vi.mock("@/lib/nextauth", () => ({ nextAuthOptions: {} }));
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }));

import { UnauthorizedError } from "@/lib/require-api-user";
import { GET } from "./route";

const user = { id: "actor-1", globalRole: "USER" as const };
const visibleWhere = { OR: [{ ownerId: "actor-1" }, { members: { some: { userId: "actor-1" } } },
  { departmentId: null, responsibleGroup: { is: { archivedAt: null, members: { some: { userId: "actor-1" } } } } },
  { department: { is: { archivedAt: null } } }] };
const row = (id: string) => ({ id, name: `Board ${id}`, owner: { email: "private@example.test" },
  _count: { tasks: 0 } });
const request = (query = "") => new Request(`http://localhost/api/projects${query}`);
const searchQuery = "?" + new URLSearchParams({ search: "Board" }).toString();

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue(user);
  mocks.readWhere.mockResolvedValue({});
  mocks.findMany.mockResolvedValue([]);
});

describe("GET /api/projects legacy contract", () => {
  it("returns the unchanged array ordered by updatedAt for clients without pagination", async () => {
    mocks.findMany.mockResolvedValue([row("b"), row("a")]);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect((await response.json()).data.map((item: { id: string }) => item.id)).toEqual(["b", "a"]);
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: visibleWhere, orderBy: { updatedAt: "desc" }, take: undefined,
    }));
  });

  it("keeps the five-row search shortcut when pagination is absent", async () => {
    await GET(request(searchQuery));
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { AND: [visibleWhere, { name: { contains: "Board", mode: "insensitive" } }] },
      orderBy: { updatedAt: "desc" }, take: 5,
    }));
  });

  it("preserves the unauthenticated response", async () => {
    mocks.auth.mockRejectedValue(new UnauthorizedError());
    expect((await GET(request())).status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});

describe("GET /api/projects cursor pagination", () => {
  it("orders by id, uses the limit+1 sentinel and returns a cursor page", async () => {
    mocks.findMany.mockResolvedValue([row("a"), row("b"), row("c")]);
    const body = await (await GET(request("?limit=2"))).json();
    expect(body.data).toEqual({ items: [row("a"), row("b")], nextCursor: "b", hasMore: true });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: visibleWhere, orderBy: { id: "asc" }, take: 3,
    }));
  });

  it("compares the cursor with gt and returns a null sentinel on the last page", async () => {
    mocks.findMany.mockResolvedValue([row("c")]);
    const body = await (await GET(request("?limit=2&cursor=b"))).json();
    expect(body.data).toEqual({ items: [row("c")], nextCursor: null, hasMore: false });
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { AND: [visibleWhere, { id: { gt: "b" } }] }, orderBy: { id: "asc" }, take: 3,
    }));
  });

  it("never loses or duplicates rows across pages", async () => {
    const rows = ["a", "b", "c", "d", "e"].map(row);
    mocks.findMany.mockImplementation(async ({ where, take }: {
      where: { AND?: [unknown, { id?: { gt?: string } }] }; take: number;
    }) => {
      const after = where.AND?.[1]?.id?.gt;
      return rows.filter(item => !after || item.id > after).slice(0, take);
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      const query: string = `?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const body: { data: { items: Array<{ id: string }>; nextCursor: string | null } } =
        await (await GET(request(query))).json();
      seen.push(...body.data.items.map((item: { id: string }) => item.id));
      cursor = body.data.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(["a", "b", "c", "d", "e"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("combines the shared search filter with stable id ordering", async () => {
    mocks.findMany.mockResolvedValue([row("a")]);
    await GET(request(`${searchQuery}&limit=1`));
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { AND: [visibleWhere, { name: { contains: "Board", mode: "insensitive" } }] },
      orderBy: { id: "asc" }, take: 2,
    }));
  });

  it.each(["?limit=0", "?limit=101", "?limit=abc", "?limit=2.5", "?limit=1e2"])(
    "rejects an invalid limit %s before querying",
    async query => {
      expect((await GET(request(query))).status).toBe(400);
      expect(mocks.findMany).not.toHaveBeenCalled();
    },
  );

  it.each(["?cursor=bad cursor", "?cursor=bad!cursor", "?cursor=" + "a".repeat(129)])(
    "rejects an invalid cursor %s before querying",
    async query => {
      expect((await GET(request(query))).status).toBe(400);
      expect(mocks.findMany).not.toHaveBeenCalled();
    },
  );
});

describe("GET /api/projects navigation projection", () => {
  it.each(["?view=navigation", "?view=navigation&search=Board"])("returns only id/name without task scope/counts or owners %s", async query => {
    mocks.findMany.mockImplementation(async (args: { select?: Record<string, boolean> }) => {
      const stored = { id: "a", name: "Board a", description: "not-needed", owner: { passwordHash: "SYNTHETIC_HASH", resetToken: "SYNTHETIC_RESET" } };
      return [Object.fromEntries(Object.entries(stored).filter(([key]) => args.select?.[key]))];
    });
    const body = await (await GET(request(query))).json();
    expect(body.data).toEqual([{ id: "a", name: "Board a" }]);
    expect(mocks.readWhere).not.toHaveBeenCalled();
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: query.includes("search") ? { AND: [visibleWhere, { name: { contains: "Board", mode: "insensitive" } }] } : visibleWhere,
      select: { id: true, name: true }, orderBy: { updatedAt: "desc" }, take: query.includes("search") ? 5 : undefined,
    });
  });
  it.each(["?view=navigation&limit=2", "?view=navigation&cursor=next"])("rejects ambiguous navigation/pagination combination %s", async query => {
    expect((await GET(request(query))).status).toBe(400);
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.readWhere).not.toHaveBeenCalled();
  });
  it("still authenticates before querying public navigation labels", async () => {
    mocks.auth.mockRejectedValue(new UnauthorizedError());
    expect((await GET(request("?view=navigation"))).status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});
it.each(["", "?limit=2"])("does not serialize owner authentication secrets in legacy or paged responses %s", async query => {
  const secrets = { passwordHash: "SYNTHETIC_HASH", resetToken: "SYNTHETIC_RESET", verificationToken: "SYNTHETIC_VERIFY" };
  const safeOwner = { id: "owner", name: "Owner", email: "owner@example.test", avatarUrl: null, globalRole: "USER" };
  mocks.findMany.mockImplementation(async (args: { include: { owner: true | { select: Record<string, boolean> } } }) => {
    const source = { ...safeOwner, ...secrets };
    const projection = args.include.owner;
    const owner = projection === true ? source : Object.fromEntries(Object.entries(source).filter(([key]) => projection.select[key]));
    return [{ id: "a", name: "Board", owner, _count: { tasks: 3 } }];
  });
  const body = await (await GET(request(query))).json();
  const item = query ? body.data.items[0] : body.data[0];
  expect(item.owner).toEqual(safeOwner);
  const serialized = JSON.stringify(body);
  for (const [field, value] of Object.entries(secrets)) {
    expect(serialized).not.toContain(field);
    expect(serialized).not.toContain(value);
  }
  expect(mocks.findMany.mock.calls[0][0].include.owner).toEqual({ select: { id: true, name: true, email: true, avatarUrl: true, globalRole: true } });
});
