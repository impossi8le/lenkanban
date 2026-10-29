// Message count privacy has its own real shared-reader contract suite.
vi.mock("@/lib/task-visible-message-counts", () => ({ readVisibleMessageCounts: async (_db:unknown,_actor:unknown,ids:string[]) => new Map(ids.map(id=>[id,{total:0,unread:0}])) }));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: vi.fn(), user: vi.fn(), token: vi.fn(), projectList: vi.fn(), project: vi.fn(), columns: vi.fn(), taskList: vi.fn(), grants: vi.fn(), update: vi.fn(), remove: vi.fn() }));
vi.mock("next-auth", () => ({ getServerSession: mocks.session }));
vi.mock("@/lib/nextauth", () => ({ nextAuthOptions: {} }));
vi.mock("@/lib/auth", () => ({ readAccountStatus: async () => ({ blocked: false }), deniesAccessForStatus: () => false, isAccountAllowed: async () => true }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  user: { findUnique: mocks.user, findFirst: mocks.user }, apiToken: { findUnique: mocks.token },
  project: { findMany: mocks.projectList, findFirst: mocks.project, findUnique: vi.fn(async()=>({name:"Synthetic board"})), update: mocks.update, delete: mocks.remove },
  projectColumn: { findMany: mocks.columns }, task: { findMany: mocks.taskList },
  $queryRaw: async () => [], taskChecklistItem: { groupBy: async () => [] },
  scopedPrivilegeAssignment: { findMany: mocks.grants },
} }));
vi.mock("@/socket/board-events", () => ({}));
vi.mock("@/lib/automation-processor", () => ({}));
vi.mock("@/lib/notification-triggers", () => ({}));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: async () => {}, rateLimitErrorResponse: vi.fn() }));
import { GET as catalog } from "./route";
import { GET as detail, PATCH, DELETE } from "./[id]/route";
import { GET as columns } from "./[id]/columns/route";
import { GET as tasks } from "../tasks/route";

type Row = Record<string, unknown>;
const actor = { id: "group-reader", email: "reader@example.invalid", globalRole: "USER" as const,
  isBlocked: false, blockedAt: null, primaryDepartmentId: null,
  responsibleGroupMemberships: [{ groupId: "responsible-group" }],
};
let project: Row;
let taskRows: Row[];
function matches(row: unknown, where: unknown): boolean {
  if (where === null || typeof where !== "object") return row === where;
  return Object.entries(where).every(([key, value]) => {
    if (key === "AND") return (Array.isArray(value) ? value : [value]).every(item => matches(row, item));
    if (key === "OR") return (value as unknown[]).some(item => matches(row, item));
    if (key === "is") return value === null ? row === null : row !== null && matches(row, value);
    if (key === "some") return Array.isArray(row) && row.some(item => matches(item, value));
    if (key === "none") return Array.isArray(row) && !row.some(item => matches(item, value));
    if (key === "not") return !matches(row, value);
    if (key === "isEmpty") return Array.isArray(row) && (row.length === 0) === value;
    if (key === "has") return Array.isArray(row) && row.includes(value);
    if (key === "in") return (value as unknown[]).includes(row);
    if (key === "notIn") return !(value as unknown[]).includes(row);
    if (key === "contains") return typeof row === "string" && row.toLowerCase().includes(String(value).toLowerCase());
    if (key === "mode") return true;
    if (key === "gt") return typeof row === "number" ? row > Number(value) : typeof row === "string" && row > String(value);
    if (row === null || typeof row !== "object" || !(key in row)) throw new Error(`Unsupported test predicate: ${key}`);
    return matches((row as Row)[key], value);
  });
}
function req(path: string, method = "GET", body?: object) {
  return new Request(`http://localhost${path}`, { method, headers: { cookie: "next-auth.session-token=synthetic", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
const context = () => ({ params: Promise.resolve({ id: "board" }) });
beforeEach(() => {
  vi.resetAllMocks();vi.stubEnv("LENKANBAN_OWN_TASK_PROJECT_IDS", "");
  mocks.session.mockResolvedValue({ user: { email: actor.email } });mocks.user.mockResolvedValue(actor);mocks.grants.mockResolvedValue([{ id: "execute", userId: actor.id, profileId: "profile", scopeKind: "board", departmentId: null, projectId: "board", profile: { archivedAt: null, permissions: ["request.execute"] } }]);
  project = { id: "board", name: "Synthetic Board", ownerId: "colleague", members: [], departmentId: null, department: null, responsibleGroupId: "responsible-group", responsibleGroup: { archivedAt: null, leaderId: null, members: [{ userId: actor.id, user: actor }] }, owner: { name: "Colleague" } };
  taskRows = ["SUBMITTED", "DRAFT"].map((state, index) => ({ id: `task-${index}`, title: `Synthetic ${state}`, projectId: "board", project, createdById: "colleague", assignees: [], watchers: [],
    request: { contractVersion: 1, state, deletedAt: null, audienceUserIds: [], authorId: "colleague", executorId: null, queueEpoch: 1, queueSeen: [] },
    priority: "LOW", status: "TODO", columnId: "queue", position: index, version: 1, description: "", deadline: null, attachments: [], tags: [], checklistItems: [], _count: { comments: 0, messages: 0, checklistItems: 0 }, createdAt: new Date(0), updatedAt: new Date(0),
  }));
  function result(query: { where: unknown; include?: { _count?: { select: { tasks: { where: unknown } } } } }) {
    if (!matches(project, query.where)) return null;
    const countWhere = query.include?._count?.select.tasks.where;
    return { ...project, _count: { tasks: taskRows.filter(task => matches(task, countWhere ?? {})).length, members: 0 } };
  }
  mocks.projectList.mockImplementation(async query => query.select
    ? matches(project, query.where ?? {}) ? [Object.fromEntries(Object.keys(query.select).map(key => [key, project[key]]))] : []
    : [result(query)].filter(Boolean));
  mocks.project.mockImplementation(async query => result(query));
  mocks.columns.mockResolvedValue([{ id: "queue", projectId: "board", workflowKey: "TODO", name: "Queue", position: 0 }]);
  mocks.taskList.mockImplementation(async query => taskRows.filter(task => matches(task, query.where)));
});
afterEach(() => vi.unstubAllEnvs());

describe("responsible group at actual session/project/list API boundaries (query-double storage)", () => {
  it.each(["", "?limit=2&search=Synthetic", "?limit=2&cursor=a"])("discovers eligible executor boards with safe shared task counts %s", async query => {
    const response = await catalog(req(`/api/projects${query}`));
    expect(response.status).toBe(200);
    const body = (await response.json()).data;
    const boards = Array.isArray(body) ? body : body.items;
    expect(boards).toHaveLength(1);expect(boards[0]._count.tasks).toBe(1);
    expect(mocks.session).toHaveBeenCalled();expect(mocks.token).not.toHaveBeenCalled();
  });
  it("reads board and columns; list excludes the colleague's draft", async () => {
    expect((await detail(req("/api/projects/board"), context())).status).toBe(200);
    expect((await columns(req("/api/projects/board/columns"), context())).status).toBe(200);
    const response = await tasks(req("/api/tasks?projectId=board"));
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data.map((task: { title: string }) => task.title)).toEqual(["Synthetic SUBMITTED"]);
    // Group staff with an explicit execute grant can read this queue arrival.
    expect(data[0].queueArrival).toEqual({ epoch: 1, unseen: true });
  });
  it("denies project mutation despite a configured-group read grant", async () => {
    expect((await PATCH(req("/api/projects/board", "PATCH", { name: "Forbidden rename" }), context())).status).toBe(404);
    expect((await DELETE(req("/api/projects/board", "DELETE"), context())).status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();expect(mocks.remove).not.toHaveBeenCalled();
  });
  it.each([null, { archivedAt: new Date(0), members: [{ userId: actor.id }] }, { archivedAt: null, leaderId: null, members: [] }])("revokes discovery, detail, columns and tasks after null/archive/removal %#", async group => {
    project.responsibleGroup = group;
    const response = await catalog(req("/api/projects"));
    expect((await response.json()).data).toEqual([]);
    expect((await detail(req("/api/projects/board"), context())).status).toBe(404);
    expect((await columns(req("/api/projects/board/columns"), context())).status).toBe(404);
    const list = await tasks(req("/api/tasks?projectId=board"));
    expect((await list.json()).data).toEqual([]);
  });
  it("preserves board membership while withholding colleague tasks if no group is configured", async () => {
    project.responsibleGroup = null;project.members = [{ userId: actor.id, role: "MEMBER" }];
    const catalogResponse = await catalog(req("/api/projects"));
    expect((await catalogResponse.json()).data[0]._count.tasks).toBe(0);
    expect((await detail(req("/api/projects/board"), context())).status).toBe(200);
    const list = await tasks(req("/api/tasks?projectId=board"));
    expect((await list.json()).data).toEqual([]);
  });
});

it("keeps navigation labels behind the responsible-group predicate and revokes them on removal", async () => {
  const allowed = await catalog(req("/api/projects?view=navigation"));
  expect((await allowed.json()).data).toEqual([{ id: "board", name: "Synthetic Board" }]);
  const [query] = mocks.projectList.mock.calls[0];
  expect(query.select).toEqual({ id: true, name: true });
  expect(query).not.toHaveProperty("include");
  expect(mocks.grants).toHaveBeenCalledOnce();
  project.responsibleGroup = { archivedAt: null, leaderId: null, members: [] };
  const denied = await catalog(req("/api/projects?view=navigation"));
  expect((await denied.json()).data).toEqual([]);
});


it("caps eligible executor task lists and project counts by selected audience without losing board discovery", async () => {
  const request = taskRows[0].request as Row;
  request.audienceUserIds = ["another-recipient"];
  const hidden = await catalog(req("/api/projects"));
  expect((await hidden.json()).data).toEqual([expect.objectContaining({ id: "board", _count: expect.objectContaining({ tasks: 0 }) })]);
  expect((await (await tasks(req("/api/tasks?projectId=board"))).json()).data).toEqual([]);
  request.audienceUserIds = [actor.id];
  const visible = await catalog(req("/api/projects"));
  expect((await visible.json()).data[0]._count.tasks).toBe(1);
  expect((await (await tasks(req("/api/tasks?projectId=board"))).json()).data.map((row: { id: string }) => row.id)).toEqual(["task-0"]);
});


it("keeps group board discovery but hides foreign counts/search/tasks without execute", async () => {
  mocks.grants.mockResolvedValue([{ id: "read", userId: actor.id, profileId: "read-profile", scopeKind: "board", departmentId: null, projectId: "board", profile: { archivedAt: null, permissions: ["request.read", "request.manage"] } }]);
  project.ownerId = actor.id;
  project.responsibleGroup = { archivedAt: null, leaderId: actor.id, members: [{ userId: actor.id, user: actor }] };
  const catalogResponse = await catalog(req("/api/projects"));
  expect((await catalogResponse.json()).data[0]._count.tasks).toBe(0);
  expect((await detail(req("/api/projects/board"), context())).status).toBe(200);
  expect((await (await tasks(req("/api/tasks?projectId=board&search=Synthetic"))).json()).data).toEqual([]);
});
