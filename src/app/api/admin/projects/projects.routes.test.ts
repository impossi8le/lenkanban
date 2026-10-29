import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ user: vi.fn(), findMany: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: { project: { findMany: mocks.findMany } } }));
vi.mock("@/lib/require-api-user", () => {
  class UnauthorizedError extends Error {
    constructor(message = "Unauthorized") {
      super(message);
      this.name = "UnauthorizedError";
    }
  }
  return { requireApiUser: mocks.user, UnauthorizedError };
});

import { UnauthorizedError } from "@/lib/require-api-user";

import { decodeProjectsCursor, encodeProjectsCursor, projectsKeysetFilter } from "./cursor";
import { GET } from "./route";

function row(index: number) {
  return {
    id: `project-${index}`,
    name: `Project ${index}`,
    description: null,
    createdAt: new Date(Date.UTC(2026, 9, 20, 10, 0, index)),
    owner: { id: "owner", email: "owner@example.invalid", name: "Synthetic owner", globalRole: "USER" as const },
    _count: { tasks: 1, members: 2 },
  };
}

function request(search = "") {
  return new Request(`https://app.test/api/admin/projects${search}`);
}

function query(params: Record<string, string>) {
  return `?${new URLSearchParams(params).toString()}`;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.user.mockResolvedValue({ id: "admin", globalRole: "ADMIN" });
});

describe("GET /api/admin/projects cursor pagination", () => {
  it("returns a bounded first page ordered by createdAt desc, id desc with an opaque cursor", async () => {
    mocks.findMany.mockResolvedValue([row(3), row(2), row(1)]);

    const response = await GET(request(query({ take: "2" })));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.data.items.map((item: { id: string }) => item.id)).toEqual(["project-3", "project-2"]);

    const cursor = body.data.nextCursor as string;
    expect(cursor).not.toBe("project-2");
    expect(decodeProjectsCursor(cursor)).toEqual({ createdAt: row(2).createdAt, id: "project-2" });

    const args = mocks.findMany.mock.calls[0][0];
    expect(args.take).toBe(3);
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(args.where).toEqual({});
    expect(args).not.toHaveProperty("cursor");
    expect(args).not.toHaveProperty("skip");
  });

  it("continues from the returned cursor without gaps and ends with nextCursor null", async () => {
    const cursor = encodeProjectsCursor({ createdAt: row(2).createdAt, id: "project-2" });
    mocks.findMany.mockResolvedValue([row(1)]);

    const response = await GET(request(query({ take: "2", cursor })));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.data.items.map((item: { id: string }) => item.id)).toEqual(["project-1"]);
    expect(body.data.nextCursor).toBeNull();
    expect(mocks.findMany.mock.calls[0][0].where).toEqual({
      AND: [projectsKeysetFilter({ createdAt: row(2).createdAt, id: "project-2" })],
    });
  });

  it("does not issue a cursor when the page is exactly full", async () => {
    mocks.findMany.mockResolvedValue([row(2), row(1)]);

    const body = await (await GET(request(query({ take: "2" })))).json();
    expect(body.data.items).toHaveLength(2);
    expect(body.data.nextCursor).toBeNull();
  });

  it("denies a non-ADMIN before reading the directory and leaks no list data", async () => {
    mocks.user.mockResolvedValue({ id: "member", globalRole: "USER" });

    const response = await GET(request(query({ take: "50" })));
    expect(response.status).toBe(404);
    expect(mocks.findMany).not.toHaveBeenCalled();

    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toContain("items");
    expect(serialized).not.toContain("@example.invalid");
    expect(serialized).not.toContain("nextCursor");
  });

  it("rejects an unauthenticated request before reading the directory", async () => {
    mocks.user.mockRejectedValue(new UnauthorizedError());

    const response = await GET(request(query({ take: "50" })));
    expect(response.status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid cursor", { cursor: "not-a-cursor" }],
    ["tampered cursor", { cursor: Buffer.from('{"createdAt":"nope","id":"project-1"}').toString("base64url") }],
    ["zero take", { take: "0" }],
    ["oversized take", { take: "101" }],
    ["non-numeric take", { take: "many" }],
  ])("rejects %s without querying", async (_label, params) => {
    const response = await GET(request(query(params)));
    expect(response.status).toBe(422);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("returns a fixed safe error when the directory read fails", async () => {
    mocks.findMany.mockRejectedValue(new Error("Synthetic failure with private-query-value"));

    const response = await GET(request(query({ take: "2" })));
    expect(response.status).toBe(500);

    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain("Не удалось загрузить проекты");
    expect(serialized).not.toContain("Synthetic failure");
    expect(serialized).not.toContain("private-query-value");
  });
});
