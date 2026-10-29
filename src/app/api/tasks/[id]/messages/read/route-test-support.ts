import { vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
const boundary = vi.hoisted(() => ({ database: {} as object, auth: vi.fn(), diagnostic: vi.fn(), internal: vi.fn(), facts: vi.fn() }));
export { boundary };
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(boundary.database, key) }) }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: boundary.auth }));
vi.mock("@/lib/logger", () => ({ apiLogger: { error: boundary.diagnostic } }));
vi.mock("../discussion-access", () => ({ canActorReadInternal: boundary.internal, loadProjectDiscussionFacts: boundary.facts }));
export function marker(state = "IN_PROGRESS") {
  return { taskId: "task-1", contractVersion: 1, state, authorId: "author", executorId: ["DRAFT","SUBMITTED"].includes(state) ? null : "executor",
    needsInfoSince: state === "NEEDS_INFO" ? new Date("2026-01-01T00:00:00Z") : null, pausedTotalMs: 0, deletedAt: null };
}
export function fixture() {
  vi.resetAllMocks();
  const options = { actor: true, isBlocked: false, blockedAt: null as Date | null, outerRole: "USER", role: "USER", readable: true,
    outerReadable: true, projectMissing: false, taskMissing: false, identityDrift: false, marker: null as unknown,
    executeFailure: false, commitFailure: false, markerFailure: false };
  const state = { readBy: { other: "earlier" } as Record<string,string> }, before = structuredClone(state);
  let working = structuredClone(state), active = false;
  const trace: string[] = [];
  boundary.auth.mockImplementation(async () => ({ id: "viewer", globalRole: options.outerRole }));
  boundary.internal.mockResolvedValue(false); boundary.facts.mockResolvedValue({ projectId: "project-1" });
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = Prisma.sql(strings, ...values).sql;
      if (text.includes('FOR SHARE OF g, gm')) { trace.push("group-lock"); return []; }
      if (text.includes('FROM "Project"')) { trace.push("project-lock"); return options.projectMissing ? [] : [{ id: "project-1" }]; }
      if (text.includes('FROM "Task"')) { trace.push("task-lock"); return options.taskMissing ? [] : [{ id: "task-1", projectId: options.identityDrift ? "foreign" : "project-1", priority: "MEDIUM", version: 1 }]; }
      if (text.includes('FROM "User"')) { trace.push("actor-lock"); return options.actor ? [{ id: "viewer" }] : []; }
      if (text.includes('FROM "TaskWatcher"')) { trace.push("watcher-lock"); return []; }
      throw Error("Unexpected lock");
    }),
    user: { findUnique: vi.fn(async () => { trace.push("fresh-actor"); return options.actor ? { id: "viewer", globalRole: options.role, isBlocked: options.isBlocked, blockedAt: options.blockedAt } : null; }) },
    project: { findMany: vi.fn(async () => [{ id: "project-1" }]), findUnique: vi.fn(async () => ({ id: "project-1", ownerId: "viewer", members: [], responsibleGroup: null })) },
    scopedPrivilegeAssignment: { findMany: vi.fn(async () => []) },
    task: { findFirst: vi.fn(async () => { trace.push("fresh-reader"); if (options.markerFailure) throw Error("synthetic-marker-storage"); return options.readable ? { id: "task-1", projectId: "project-1", request: options.marker } : null; }) },
    taskRequest: { findMany: vi.fn(async () => options.marker === null ? [] : [options.marker]) },
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      trace.push("execute"); if (!active) throw Error("Outside transaction"); if (options.executeFailure) throw Error("synthetic-private-execute");
      if (working.readBy.viewer) return 0; working.readBy.viewer=String(Prisma.sql(strings,...values).values[1]); return 1;
    }),
  };
  const database = { task: { findFirst: vi.fn(async () => options.outerReadable ? { id: "task-1", projectId: "project-1" } : null) },
    project: { findMany: vi.fn(async () => [{ id: "project-1" }]) }, scopedPrivilegeAssignment: { findMany: vi.fn(async () => []) },
    $executeRaw: vi.fn(), $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
      trace.push("begin"); active=true; working=structuredClone(state);
      try { const result=await callback(tx); if(options.commitFailure) throw Error("synthetic-private-commit"); state.readBy=working.readBy; trace.push("commit"); return result; }
      finally { active=false; }
    }) };
  boundary.database=database;
  function request(body: unknown = { messageIds: ["shown"] }) { return new NextRequest("https://app.invalid/api/tasks/task-1/messages/read", { method:"POST", body:JSON.stringify(body), headers:{"Content-Type":"application/json"} }); }
  return { options,tx,database,state,before,trace,request,context:{params:Promise.resolve({id:"task-1"})},
    statement:()=>{const [strings,...values]=tx.$executeRaw.mock.calls[0];return Prisma.sql(strings,...values);} };
}
