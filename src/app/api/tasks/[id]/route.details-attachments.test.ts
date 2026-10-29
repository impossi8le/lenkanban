import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  transaction: vi.fn(),
  where: vi.fn(),
  arrivals: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));
vi.mock("@/lib/request-queue-unseen", () => ({ readRequestQueueArrivalMap: mocks.arrivals }));
vi.mock("@/lib/project-access", () => ({ getTaskReadWhere: mocks.where, requireTaskWrite: vi.fn() }));
vi.mock("@/lib/require-api-user", async () => ({
  requireApiUser: mocks.auth,
  UnauthorizedError: (await import("@/lib/errors")).UnauthorizedError,
}));
vi.mock("@/lib/notification-triggers", () => ({}));
vi.mock("@/lib/automation-processor", () => ({}));
vi.mock("@/socket/board-events", () => ({}));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: vi.fn(), warn: vi.fn() } }));

import { GET } from "./route";

const publicFile = {
  url: "/api/tasks/task-1/files/00000000-0000-4000-8000-000000000001",
  name: "public.txt", size: 6, mime: "text/plain",
};
const internalFile = {
  ...publicFile,
  url: "/api/tasks/task-1/files/00000000-0000-4000-8000-000000000002",
  name: "internal.txt",
  isInternal: true,
};
const storedTask = {
  id: "task-1", title: "Synthetic", description: null, status: "TODO", priority: "MEDIUM",
  position: 1024, rank: "0000000000000000001", version: 1, projectId: "project-1",
  columnId: "column-1", createdById: "reader", importKey: null, deadline: null,
  createdAt: new Date("2026-09-01T12:00:00Z"), updatedAt: new Date("2026-09-01T12:00:00Z"),
  attachments: [publicFile, internalFile], assignees: [], tags: [], checklistItems: [],
  activities: [],
};

function fixture(groupMemberIds: string[]) {
  const tx = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, globalRole: "USER" })),
      findMany: vi.fn(async () => []),
    },
    task: { findFirst: vi.fn(async () => storedTask) },
    project: { findUnique: vi.fn(async () => ({
      id: "project-1", departmentId: null, department: null, responsibleGroupId: "group",
      responsibleGroup: { id: "group", archivedAt: null, members: groupMemberIds.map(userId => ({ userId })) },
    })) },
    scopedPrivilegeAssignment: { findMany: vi.fn(async () => []) },
  };
  mocks.transaction.mockImplementation(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx));
  return tx;
}

async function details() {
  return GET(new Request("http://localhost/api/tasks/task-1?view=details"), {
    params: Promise.resolve({ id: "task-1" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ id: "reader", globalRole: "USER" });
  mocks.where.mockResolvedValue({});
  mocks.arrivals.mockResolvedValue(new Map([["task-1", { epoch: 4, unseen: true }]]));
});

describe("task detail attachment read boundary", () => {
  it("does not return an internal file to an ordinary task reader", async () => {
    fixture(["someone-else"]);
    const response = await details();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.attachments).toEqual([publicFile]);
    expect(body.data.queueArrival).toEqual({ epoch: 4, unseen: true });
    expect(JSON.stringify(body)).not.toContain("internal.txt");
    expect(JSON.stringify(body)).not.toContain("isInternal");
  });

  it("returns the internal file to an authorized active group reader without the flag", async () => {
    fixture(["reader"]);
    const response = await details();
    const body = await response.json();
    const internalDto = { url: internalFile.url, name: internalFile.name, size: internalFile.size, mime: internalFile.mime };
    expect(body.data.attachments).toEqual([publicFile, internalDto]);
    expect(body.data.attachments[1]).not.toHaveProperty("isInternal");
  });

  it("drops the internal file again after the reader's group access is revoked", async () => {
    const tx = fixture(["reader"]);
    expect((await (await details()).json()).data.attachments).toHaveLength(2);
    tx.project.findUnique.mockResolvedValue({
      id: "project-1", departmentId: null, department: null, responsibleGroupId: "group",
      responsibleGroup: { id: "group", archivedAt: null, members: [{ userId: "someone-else" }] },
    });
    expect((await (await details()).json()).data.attachments).toEqual([publicFile]);
  });
});
