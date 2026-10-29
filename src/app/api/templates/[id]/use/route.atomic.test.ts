import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRank } from "@/features/kanban/rank/rank-service";
import { UnauthorizedError } from "@/lib/errors";
import { inspect } from "node:util";

const api = vi.hoisted(() => ({
  database: {} as object, auth: vi.fn(), emit: vi.fn(), diagnostic: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(api.database, key) }) }));
vi.mock("@/lib/require-api-user", async () => ({ requireApiUser: api.auth, UnauthorizedError: (await import("@/lib/errors")).UnauthorizedError }));
vi.mock("@/socket/board-events", () => ({ emitTaskCreated: api.emit }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: api.diagnostic, warn: api.diagnostic } }));

import { POST } from "./route";

const projectId = "project", columnId = "column", taskId = "created";
const palette = ["#ef4444", "#f97316", "#f59e0b", "#84cc16", "#10b981", "#06b6d4", "#3b82f6", "#0ea5e9", "#ec4899"];
const projection = {
  assignees: { include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } } },
  tags: { include: { tag: true } }, checklistItems: { orderBy: { position: "asc" } },
  createdBy: { select: { id: true, name: true, email: true } },
};
type Task = { id: string; projectId: string; columnId: string; [key: string]: unknown };
type Tag = { id: string; projectId: string; name: string; color: string };
type Item = { taskId: string; text: string; completed: boolean; position: number };
type State = { tasks: Task[]; checklist: Item[]; tags: Tag[]; links: { taskId: string; tagId: string }[] };

/** The fixture models commit/rollback in memory. It is not a PostgreSQL test. */
function fixture() {
  const state: State = { tasks: [], checklist: [], tags: [{ id: "existing-tag", projectId, name: "Existing", color: "#123456" }], links: [] };
  const before = structuredClone(state); let working = structuredClone(state), committed = false;
  const trace: string[] = [], options = { fail: "", projection: "", createIdentity: "", emptyColumn: false };
  const template = {
    id: "template", projectId, templateTitle: "Synthetic title", templateDescription: "synthetic-private-description", priority: "HIGH",
    checklistItems: [{ text: "synthetic-private-checklist", completed: true }, { text: "Second", completed: false }], tags: ["Existing", "New tag"],
    project: { id: projectId, ownerId: "actor", members: [] as { userId: string }[] },
  };
  function methods(current: () => State, scope: "tx" | "global") {
    const hit = (name: string) => { trace.push(`${scope}:${name}`); if (options.fail === name) throw new Error(`synthetic-private-${name}`); };
    return {
      project: { findUnique: vi.fn(async () => ({ ownerId: "actor", members: [], applicantPolicyConfig: null, responsibleGroup: null, columns: [{id: columnId}] })) },
      projectColumn: { findFirst: vi.fn(async () => ({ id: columnId, workflowKey: "TODO" })) },
      task: {
        findFirst: vi.fn(async ({ orderBy }: { orderBy: { rank?: string; position?: string } }) => options.emptyColumn ? null : orderBy.rank ? { rank: formatRank(100n) } : { position: 8 }),
        findMany: vi.fn(async () => []), update: vi.fn(),
        create: vi.fn(async ({ data }: { data: Task }) => {
          hit("create"); const task = { ...data, id: taskId, createdAt: new Date("2026-10-21T10:00:00Z") }; current().tasks.push(task);
          const result = structuredClone(task);
          if (options.createIdentity === "missing-id") Reflect.deleteProperty(result, "id");
          else if (options.createIdentity === "nonstring-id") Reflect.set(result, "id", 42);
          else if (options.createIdentity) Reflect.set(result, options.createIdentity, "wrong-target");
          return result;
        }),
        findUnique: vi.fn(async (input: { where: { id: string }; include: unknown }) => {
          hit("projection"); expect(input).toEqual({ where: { id: taskId }, include: projection });
          if (options.projection === "null") return null;
          const task = current().tasks.find(row => row.id === taskId)!;
          const result = { ...structuredClone(task), assignees: [], tags: current().links.map(link => ({ ...link, tag: structuredClone(current().tags.find(tag => tag.id === link.tagId)!) })), checklistItems: structuredClone(current().checklist), createdBy: { id: "actor", name: "Synthetic actor", email: "synthetic@example.invalid" } };
          if (options.projection === "missing-id") Reflect.deleteProperty(result, "id");
          else if (options.projection === "nonstring-id") Reflect.set(result, "id", 42);
          else if (options.projection) Object.assign(result, { [options.projection]: "wrong-target" });
          return result;
        }),
      },
      taskChecklistItem: { createMany: vi.fn(async ({ data }: { data: Item[] }) => { hit("checklist"); current().checklist.push(...structuredClone(data)); return { count: data.length }; }) },
      tag: {
        findFirst: vi.fn(async ({ where }: { where: { projectId: string; name: string } }) => { hit("tagfind"); return current().tags.find(tag => tag.projectId === where.projectId && tag.name === where.name) ?? null; }),
        create: vi.fn(async ({ data }: { data: Omit<Tag, "id"> }) => { hit("tagcreate"); const tag = { id: "new-tag", ...data }; current().tags.push(tag); return tag; }),
      },
      taskTag: { create: vi.fn(async ({ data }: { data: { taskId: string; tagId: string } }) => { hit("link"); current().links.push({ ...data }); return data; }) },
    };
  }
  const txMethods = methods(() => working, "tx"), globalMethods = methods(() => state, "global");
  const tx = {
    ...txMethods,
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join("?"); trace.push("resource-lock");
      return sql.includes('FROM "ProjectColumn"') ? [{ id: columnId, projectId }] : [{ id: projectId }];
    }),
    taskRequest: { findMany: vi.fn() },
  };
  const database = {
    ...globalMethods,
    taskTemplate: { findUnique: vi.fn(async () => template) },
    projectColumn: { findFirst: vi.fn(async () => ({ id: columnId, projectId, workflowKey: "DONE" })) },
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      trace.push("begin"); working = structuredClone(state);
      const result = await callback(tx); trace.push("commit-attempt");
      if (options.fail === "commit") throw new Error("synthetic-private-commit");
      Object.assign(state, structuredClone(working)); committed = true; trace.push("commit"); return result;
    }),
  };
  api.database = database;
  api.emit.mockImplementation(() => { expect(committed).toBe(true); trace.push("emit"); });
  const run = () => POST(new Request("http://localhost/api/templates/template/use", { method: "POST", body: "{}" }), { params: Promise.resolve({ id: "template" }) });
  const noGlobalWritesOrReread = () => {
    for (const method of [globalMethods.task.create, globalMethods.task.update, globalMethods.task.findUnique, globalMethods.taskChecklistItem.createMany, globalMethods.tag.findFirst, globalMethods.tag.create, globalMethods.taskTag.create]) expect(method).not.toHaveBeenCalled();
  };
  return { state, before, trace, options, template, tx, database, run, noGlobalWritesOrReread };
}
beforeEach(() => { vi.resetAllMocks(); api.auth.mockResolvedValue({ id: "actor", globalRole: "USER" }); });
afterEach(() => { vi.restoreAllMocks(); });

describe("task-template use atomic children and committed response (modeled transaction)", () => {
  it("cannot use a template to bypass missing applicant initial column", async () => {
    const f = fixture();
    f.tx.project.findUnique.mockResolvedValue({ ownerId: "actor", members: [], applicantPolicyConfig: null, responsibleGroup: null, columns: [] });
    expect((await f.run()).status).toBe(403);
    expect(f.tx.task.create).not.toHaveBeenCalled(); expect(f.tx.task.update).not.toHaveBeenCalled();
    expect(api.emit).not.toHaveBeenCalled(); expect(f.state).toEqual(f.before);
  });
  it("creates Task, false checklist, reused/new tags, links and the complete legacy projection in one transaction", async () => {
    const f = fixture(); const response = await f.run();
    expect(response.status).toBe(201); const task = (await response.json()).data;
    expect(task).toMatchObject({ id: taskId, projectId, columnId, title: "Synthetic title", description: "synthetic-private-description", priority: "HIGH", status: "TODO", position: 9, createdById: "actor", assignees: [], createdBy: { id: "actor" } });
    expect(task.checklistItems).toEqual(f.template.checklistItems.map((item, position) => ({ taskId, text: item.text, completed: false, position })));
    expect(task.tags.map((link: { tagId: string }) => link.tagId)).toEqual(["existing-tag", "new-tag"]);
    expect(f.state.tags).toHaveLength(2); expect(palette).toContain(f.state.tags[1].color);
    expect(f.tx.tag.create).toHaveBeenCalledOnce(); expect(f.tx.taskTag.create).toHaveBeenCalledTimes(2);
    f.noGlobalWritesOrReread(); expect(f.database.$transaction).toHaveBeenCalledOnce(); expect(api.emit).toHaveBeenCalledOnce();
    expect(api.emit.mock.calls[0][0]).toBe(projectId); expect(JSON.parse(JSON.stringify(api.emit.mock.calls[0][1]))).toEqual(task);
    expect(f.trace.indexOf("tx:create")).toBeLessThan(f.trace.indexOf("tx:checklist"));
    expect(f.trace.lastIndexOf("tx:link")).toBeLessThan(f.trace.indexOf("tx:projection"));
    expect(f.trace.indexOf("tx:projection")).toBeLessThan(f.trace.indexOf("commit"));
    expect(f.trace.indexOf("commit")).toBeLessThan(f.trace.indexOf("emit"));
  });

  it.each(["create", "checklist", "tagfind", "tagcreate", "link", "projection", "commit"])("models rollback with safe500 and no delivery on %s failure", async failure => {
    const f = fixture(); f.options.fail = failure;
    const response = await f.run(); expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/synthetic-private|Synthetic title|synthetic@example/);
    expect(f.state).toEqual(f.before); expect(api.emit).not.toHaveBeenCalled(); f.noGlobalWritesOrReread();
    expect(f.database.$transaction).toHaveBeenCalledOnce();
  });

  it.each(["null", "id", "missing-id", "nonstring-id", "projectId", "columnId"])("rejects %s complete projection inside transaction before commit", async mismatch => {
    const f = fixture(); f.options.projection = mismatch;
    const response = await f.run(); expect(response.status).toBe(500);
    expect(f.state).toEqual(f.before); expect(f.trace).not.toContain("commit"); expect(api.emit).not.toHaveBeenCalled();
    f.noGlobalWritesOrReread();
  });

  it.each(["missing-id", "nonstring-id", "projectId", "columnId"])("rejects corrupt Task create %s identity before children and commit", async mismatch => {
    const f = fixture(); f.options.createIdentity = mismatch;
    const response = await f.run(); expect(response.status).toBe(500);
    expect(f.state).toEqual(f.before); expect(f.trace).not.toContain("commit"); expect(api.emit).not.toHaveBeenCalled();
    expect(f.tx.taskChecklistItem.createMany).not.toHaveBeenCalled(); expect(f.tx.tag.findFirst).not.toHaveBeenCalled();
    f.noGlobalWritesOrReread();
  });

  it.each(["sync", "async"])("retains committed201 and safe diagnostics after %s realtime failure", async mode => {
    const f = fixture(); api.emit.mockImplementation(() => { if (mode === "sync") throw new Error("synthetic-private-effect"); return Promise.reject(new Error("synthetic-private-effect")); });
    const response = await f.run(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(response.status).toBe(201); expect((await response.json()).data).toMatchObject({ id: taskId, tags: [{ tagId: "existing-tag" }, { tagId: "new-tag" }] });
    expect(api.emit).toHaveBeenCalledOnce(); expect(api.diagnostic).toHaveBeenCalled(); f.noGlobalWritesOrReread();
    expect(inspect(api.diagnostic.mock.calls, { depth: null })).not.toMatch(/synthetic-private|Synthetic title|synthetic@example/);
  });

  it.each(["sync", "async"])("contains %s diagnostic failure after committed delivery failure", async mode => {
    const f = fixture(); api.emit.mockImplementation(() => { throw new Error("synthetic-private-effect"); });
    api.diagnostic.mockImplementation(() => { if (mode === "sync") throw new Error("synthetic-private-sink"); return Promise.reject(new Error("synthetic-private-sink")); });
    const response = await f.run(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(response.status).toBe(201); expect((await response.json()).data).toHaveProperty("id", taskId); expect(api.emit).toHaveBeenCalledOnce();
  });

  it.each(["sync", "async"])("retains safe500 and modeled rollback after precommit failure plus %s diagnostic failure", async mode => {
    const f = fixture(); f.options.fail = "checklist";
    api.diagnostic.mockImplementation(() => { if (mode === "sync") throw new Error("synthetic-private-sink"); return Promise.reject(new Error("synthetic-private-sink")); });
    const response = await f.run(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(response.status).toBe(500); expect(await response.text()).not.toMatch(/synthetic-private|Synthetic title|synthetic@example/);
    expect(f.state).toEqual(f.before); expect(api.emit).not.toHaveBeenCalled(); f.noGlobalWritesOrReread();
  });

  it("isolates nested realtime mutation from committed DTO and modeled persisted state", async () => {
    const f = fixture(); api.emit.mockImplementation((_project: string, task: { title: string; tags: { tag: { name: string } }[]; checklistItems: Item[] }) => { task.title = "mutated"; task.tags[0].tag.name = "mutated"; task.checklistItems.length = 0; });
    const response = await f.run(); expect(response.status).toBe(201); const task = (await response.json()).data;
    expect(task.title).toBe("Synthetic title"); expect(task.tags[0].tag.name).toBe("Existing"); expect(task.checklistItems).toHaveLength(2);
    expect(f.state.tasks[0].title).toBe("Synthetic title"); expect(f.state.tags[0].name).toBe("Existing"); expect(f.state.checklist).toHaveLength(2);
  });

  it("does not wait for a pending defensive async emitter to return the committed response", async () => {
    const f = fixture(); let release!: () => void;
    api.emit.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
    const pending = f.run();
    try {
      const response = await Promise.race([pending, new Promise<null>(resolve => setTimeout(() => resolve(null), 0))]);
      expect(response).not.toBeNull(); expect(response!.status).toBe(201);
      expect((await response!.json()).data).toHaveProperty("id", taskId); expect(api.emit).toHaveBeenCalledOnce();
    } finally { release(); await pending; }
  });

  it("contains a throwing then getter from a defensive emitter double", async () => {
    const f = fixture(); api.emit.mockImplementation(() => Object.defineProperty({}, "then", { get() { throw new Error("synthetic-private-then"); } }));
    const response = await f.run(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(response.status).toBe(201); expect((await response.json()).data).toHaveProperty("id", taskId);
    expect(api.emit).toHaveBeenCalledOnce(); expect(api.diagnostic).toHaveBeenCalledOnce();
  });

  it("preserves Date type in the independent emitter payload and its committed JSON value", async () => {
    const f = fixture(); let dateWasPreserved = false;
    api.emit.mockImplementation((_project: string, task: { createdAt: Date }) => { dateWasPreserved = task.createdAt instanceof Date; task.createdAt.setUTCFullYear(2000); });
    const response = await f.run(); expect(response.status).toBe(201);
    expect((await response.json()).data.createdAt).toBe("2026-10-21T10:00:00.000Z"); expect(dateWasPreserved).toBe(true);
    expect(f.state.tasks[0].createdAt).toEqual(new Date("2026-10-21T10:00:00Z"));
  });

  it("keeps an empty checklist/tag template valid and avoids child writes", async () => {
    const f = fixture(); f.template.checklistItems = []; f.template.tags = []; f.options.emptyColumn = true;
    const response = await f.run(); expect(response.status).toBe(201);
    expect((await response.json()).data).toMatchObject({ checklistItems: [], tags: [], position: 0 });
    expect(f.tx.taskChecklistItem.createMany).not.toHaveBeenCalled(); expect(f.tx.tag.findFirst).not.toHaveBeenCalled(); expect(f.tx.taskTag.create).not.toHaveBeenCalled();
    f.noGlobalWritesOrReread();
  });

  it.each(["auth", "missing", "forbidden", "column"])("preserves %s preflight without transaction or effects", async kind => {
    const f = fixture();
    if (kind === "auth") api.auth.mockRejectedValue(new UnauthorizedError());
    if (kind === "missing") f.database.taskTemplate.findUnique.mockResolvedValue(null as never);
    if (kind === "forbidden") f.template.project.ownerId = "other";
    if (kind === "column") f.database.projectColumn.findFirst.mockResolvedValue(null as never);
    const response = await f.run(); expect(response.status).toBe({ auth: 401, missing: 404, forbidden: 403, column: 400 }[kind]);
    expect(f.database.$transaction).not.toHaveBeenCalled(); expect(api.emit).not.toHaveBeenCalled(); expect(f.state).toEqual(f.before);
  });
});
