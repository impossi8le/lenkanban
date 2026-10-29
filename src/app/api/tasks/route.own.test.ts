import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/task-visible-message-counts", () => ({ readVisibleMessageCounts: async (_db: unknown, _actor: unknown, ids: readonly string[]) => new Map(ids.map(id => [id, { total: 0, unread: 0 }])) }));
vi.mock("@/lib/request-queue-unseen", () => ({ readRequestQueueArrivalMap: async (_db: unknown, _actor: string, ids: string[]) => new Map(ids.map(id => [id, null])) }));
// Admission is covered separately; these fixtures exercise access predicates.
vi.mock("@/lib/rate-limit", async original => ({
  ...await original<typeof import("@/lib/rate-limit")>(), rateLimitOrThrowKey: async () => {},
}));
import { taskSearchPredicate } from "@/lib/task-search";
import { taskReadPredicate } from "@/lib/access-policy";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), user: vi.fn(), token: vi.fn(), tokenUpdate: vi.fn(),
  list: vi.fn(), single: vi.fn(), unique: vi.fn(), grants: vi.fn(),
  projects: vi.fn(), project: vi.fn(), transaction: vi.fn(),
}));
vi.mock("next-auth", () => ({ getServerSession: mocks.session }));
vi.mock("@/lib/nextauth", () => ({ nextAuthOptions: {} }));
vi.mock("@/lib/auth", () => ({ readAccountStatus: async () => ({ blocked: false }),
  deniesAccessForStatus: () => false, isAccountAllowed: async () => true }));
vi.mock("@/lib/api-tokens", () => ({
  parseApiToken: (value: string) => value === "synthetic-valid" ? { id: "token" } : null,
  hashApiToken: () => "synthetic-hash",
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  user: { findUnique: mocks.user }, apiToken: { findUnique: mocks.token, update: mocks.tokenUpdate },
  scopedPrivilegeAssignment: { findMany: mocks.grants },
  task: { findMany: mocks.list, findFirst: mocks.single, findUnique: mocks.unique },
  project: { findMany: mocks.projects, findFirst: mocks.project, findUnique: async () => null }, $transaction: mocks.transaction,
} }));
vi.mock("@/socket/board-events", () => ({}));
vi.mock("@/lib/automation-processor", () => ({}));
vi.mock("@/lib/notification-triggers", () => ({}));

import { GET as list } from "./route";
import { GET as detail } from "./[id]/route";
import { GET as projects } from "../projects/route";
import { GET as project } from "../projects/[id]/route";
import { PUT as assign } from "./[id]/assignees/route";
import { GET as checklist } from "./[id]/checklist/route";
import { GET as messages } from "./[id]/messages/route";
import { GET as watchers } from "./[id]/messages/watchers/route";
import { POST as readMessages } from "./[id]/messages/read/route";

const actor = { id: "employee", email: "synthetic@example.invalid", globalRole: "USER" as const };
const policy = taskReadPredicate(actor, ["own"], [], true);
const snapshot = { projectId: { in: ["own"] } };
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "own");
  mocks.session.mockResolvedValue({ user: { email: actor.email } });
  mocks.user.mockResolvedValue(actor);
  mocks.token.mockResolvedValue({ id: "token", revokedAt: null, scopes: ["request.update"], user: actor });
  mocks.tokenUpdate.mockResolvedValue({}); mocks.grants.mockResolvedValue([]);
  mocks.list.mockResolvedValue([]); mocks.single.mockResolvedValue(null);
  mocks.unique.mockImplementation(() => { throw new Error("Unscoped task read"); });
  mocks.projects.mockImplementation(async query => query.select
    ? [{ id: "own" }].filter(board => !query.where || board.id === query.where.id) : []);
  mocks.project.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

function request(path: string, transport: string) {
  return new Request(`http://localhost${path}`, { headers: transport === "bearer"
    ? { authorization: "Bearer synthetic-valid" } : { cookie: "next-auth.session-token=synthetic" } });
}

describe.each(["cookie", "bearer"])("OWN at actual API/auth boundaries: %s (mock storage)", transport => {
  it.each(["", "?assignedToMe=true", "?assignedToMe=false", "?projectId=own", "?projectId=foreign", "?search=foreign-title"])(
    "keeps the policy when the client changes filters %s", async query => {
      const response = await list(request(`/api/tasks${query}`, transport));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: [] });
      expect(mocks.list).toHaveBeenCalledTimes(2);
       const where = mocks.list.mock.calls[0][0].where.AND[0].AND[0];
      const selectedProject = new URLSearchParams(query).get("projectId");
      expect(mocks.projects).toHaveBeenCalledExactlyOnceWith({
        ...(selectedProject ? { where: { id: selectedProject } } : {}), select: { id: true },
      });
      if (selectedProject === "foreign") {
        // A missing bounded snapshot must deny all, never revive legacy access.
        expect(where).toEqual({ AND: [{ projectId: { in: [] } }, {
          AND: [{ projectId: "foreign" }, { projectId: "foreign" }],
        }] });
        expect(mocks.grants).not.toHaveBeenCalled();
      } else {
        expect(where.AND[0]).toEqual(policy);
        expect(where.AND[1]).toEqual(snapshot);
        expect(where.AND).toHaveLength(3);
      }
      if (query.includes("assignedToMe=true")) expect(where.AND[2]).toEqual({ OR: [
        { request: { is: { contractVersion: 1, executorId: actor.id, deletedAt: null } } },
        { request: { is: null }, assignees: { some: { userId: actor.id } } },
      ] });
      if (selectedProject === "own") expect(where.AND[2]).toEqual({
        AND: [{ projectId: "own" }, { projectId: "own" }],
      });
      if (query.includes("search=")) expect(where.AND[2].AND[1]).toEqual(taskSearchPredicate("foreign-title"));
      if (transport === "bearer") {
        expect(mocks.token).toHaveBeenCalledWith({ where: { tokenHash: "synthetic-hash" }, include: { user: true } });
        expect(mocks.session).not.toHaveBeenCalled();
      } else {
        expect(mocks.session).toHaveBeenCalledOnce();
        expect(mocks.user).toHaveBeenCalledWith({ where: { email: actor.email } });
        expect(mocks.token).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["mine", "reply"])("narrows personal scope %s by canonical author inside shared OWN policy", async requestScope => {
    const response = await list(request(`/api/tasks?requestScope=${requestScope}`, transport));
    expect(response.status).toBe(200);
     const where = mocks.list.mock.calls[0][0].where.AND[0].AND[0];
    expect(where.AND[0]).toEqual(policy); expect(where.AND[1]).toEqual(snapshot);
    if (requestScope === "reply") expect(where.AND[2]).toEqual({ request: { is: { contractVersion: 1, authorId: actor.id, state: "NEEDS_INFO", deletedAt: null } } });
    else expect(where.AND[2]).toEqual({ AND: [{ OR: [
      { request: { is: { contractVersion: 1, authorId: actor.id, deletedAt: null } } },
      { request: { is: null }, createdById: actor.id },
    ] }] });
  });

  it("combines personal and assigned filters without replacing either policy", async () => {
    const response = await list(request("/api/tasks?requestScope=mine&assignedToMe=true", transport));
    expect(response.status).toBe(200);
     const where = mocks.list.mock.calls[0][0].where.AND[0].AND[0];
    expect(where.AND[0]).toEqual(policy); expect(where.AND[1]).toEqual(snapshot);
    expect(where.AND[2].OR[0].request.is.executorId).toBe(actor.id);
    expect(where.AND[2].AND[0].OR[0].request.is.authorId).toBe(actor.id);
  });

  it("does not expose titles via a direct ID or forged projectId", async () => {
    const response = await detail(request("/api/tasks/foreign?projectId=own", transport), { params: Promise.resolve({ id: "foreign" }) });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toMatch(/foreign-title|department|owner/);
    expect(mocks.single).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [policy, snapshot, { id: "foreign" }] } }));
    expect(mocks.unique).not.toHaveBeenCalled();
  });

  it("preserves the owner's direct draft read without the list-only visibility restriction", async () => {
    const draft = { id: "owned-draft", title: "Saved draft", projectId: "own",
      request: { contractVersion: 1, state: "DRAFT", authorId: actor.id, deletedAt: null } };
    mocks.single.mockResolvedValue(draft);
    const response = await detail(request("/api/tasks/owned-draft", transport), {
      params: Promise.resolve({ id: draft.id }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { id: draft.id } });
    expect(mocks.single).toHaveBeenCalledWith(expect.objectContaining({
      where: { AND: [policy, snapshot, { id: draft.id }] },
    }));
  });

  it("filters project task counts using the same predicate", async () => {
    expect((await projects(request("/api/projects", transport))).status).toBe(200);
    expect(mocks.projects.mock.calls.find(call => call[0]?.include?._count)![0].include._count.select.tasks.where).toEqual({ AND: [policy, snapshot, {}] });
    expect((await project(request("/api/projects/own", transport), { params: Promise.resolve({ id: "own" }) })).status).toBe(404);
    expect(mocks.project.mock.calls[0][0].include._count.select.tasks.where).toEqual({
      AND: [policy, snapshot, { AND: [{}, { projectId: "own" }] }],
    });
  });

  it("rejects self-assignment on an unseen OWN task before a transaction or effects", async () => {
    mocks.unique.mockResolvedValue({ id: "foreign", projectId: "own", project: { ownerId: "other" } });
    const headers = Object.fromEntries(request("/api/tasks/foreign", transport).headers);
    const response = await assign(new Request("http://localhost/api/tasks/foreign/assignees", {
      method: "PUT", headers, body: JSON.stringify({ userIds: [actor.id], createdById: actor.id }),
    }), { params: Promise.resolve({ id: "foreign" }) });
    expect(response.status).toBe(404);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each(["checklist", "messages", "watchers", "read"])("guards child channel %s before child data is read", async channel => {
    mocks.unique.mockResolvedValue({ projectId: "own" });
    const req = request(`/api/tasks/foreign/${channel}`, transport);
    const context = { params: Promise.resolve({ id: "foreign" }) };
    const response = channel === "read"
      ? await readMessages(new NextRequest(req), context)
      : await ({ checklist, messages, watchers }[channel as "checklist" | "messages" | "watchers"])(req, context);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toMatch(/foreign-title|department|owner/);
    expect(mocks.single).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [policy, snapshot, { id: "foreign" }] } }));
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

it("rejects multiple legacy executors on an opted-in board, even for ADMIN", async () => {
  mocks.user.mockResolvedValue({ ...actor, globalRole: "ADMIN" });
  mocks.unique.mockResolvedValue({ id: "task", projectId: "own", project: { ownerId: actor.id } });
  const response = await assign(new Request("http://localhost/api/tasks/task/assignees", {
    method: "PUT", body: JSON.stringify({ userIds: ["one", "two"] }),
  }), { params: Promise.resolve({ id: "task" }) });
  expect(response.status).toBe(400);
  expect(mocks.transaction).not.toHaveBeenCalled();
});
