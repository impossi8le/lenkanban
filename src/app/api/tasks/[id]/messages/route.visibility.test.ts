import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  db: {} as Record<string, unknown>,
  auth: vi.fn(),
  rate: vi.fn(),
  notify: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(runtime.db, key) }) }));
vi.mock("@/lib/require-api-user", () => ({
  requireApiUser: runtime.auth,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimitOrThrowKey: runtime.rate,
  rateLimitErrorResponse: () => new Response(null, { status: 429 }),
}));
vi.mock("@/lib/notifications", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/notifications")>(),
  persistNotificationsWithClient: vi.fn(async (_db, rows) => { runtime.notify(rows); return []; }),
}));
vi.mock("@/socket/board-events", () => ({ emitTaskMessageCreated: runtime.emit }));

import { GET, POST } from "./route";
import { UnauthorizedError } from "@/lib/require-api-user";

type Message = {
  id: string;
  clientId?: string | null;
  taskId: string;
  authorId: string;
  contentText: string;
  attachments: unknown[];
  createdAt: Date;
  version?: number; deletedAt?: Date | null; editedAt?: Date | null; mentions?: string[]; reactions?: Record<string,string[]>;
};

const publicAuthor = { id: "author", email: "author@example.invalid", name: "Author", avatarUrl: null };

function fixture(options: {
  role?: "USER" | "ADMIN";
  legacyWrite?: boolean;
  requestMarker?: { state: string; authorId: string; contractVersion: number; deletedAt: Date | null };
  groupMember?: boolean;
  watcher?: boolean;
  taskAccess?: boolean;
  factsAvailable?: boolean;
  internalIds?: string[];
  messages?: Message[];
  markSucceeds?: boolean;
  assignees?: string[];
  watchers?: string[];
  internalColumnMissing?: boolean;
  internalStorageFailure?: boolean;
  uniqueFailure?: boolean;
  watcherInsideTx?: boolean;
  storedAttachments?: Array<{ url: string; name: string; size: number; mime: string; isInternal?: boolean; pendingMessageAuthorId?:string }>;
} = {}) {
  const state = {
    messages: structuredClone(options.messages ?? [
      { id: "public-1", clientId: null, taskId: "task", authorId: "author", contentText: "Public", attachments: [], createdAt: new Date("2026-10-21T10:00:00Z") },
      { id: "internal-1", clientId: null, taskId: "task", authorId: "member", contentText: "Internal", attachments: [], createdAt: new Date("2026-10-21T10:01:00Z") },
    ]),
    internalIds: new Set(options.internalIds ?? ["internal-1"]),
    attachments: structuredClone(options.storedAttachments ?? []),
  };
  let sequence = 0;

  const executeRaw = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    expect(parts.join("?")).toContain('SET "isInternal" = true');
    if (!options.markSucceeds) return 0;
    state.internalIds.add(values[0] as string);
    return 1;
  });

  const tx = {
    $queryRaw: vi.fn(async (parts: TemplateStringsArray) => {
      const sql = parts.join("?");
      if (sql.includes('FROM "Project"')) return [{ id: "project" }];
      if (sql.includes('FROM "Task"')) return [{ id: "task", projectId: "project", priority: "MEDIUM", version: 1 }];
      if (sql.includes('FROM "TaskWatcher"')) {
        if (!sql.includes('"userId" =')) return (options.watchers ?? []).map(userId => ({userId}));
        return options.watcherInsideTx === false ? [] : [{ userId: "actor" }];
      }
      return [{ id: "actor" }];
    }),
    $executeRaw: executeRaw,
    user: { findUnique: vi.fn(async ({where}: {where:{id:string}}) => ({ id: where.id, globalRole: where.id === "actor" ? options.role ?? "USER" : "USER", name: null, isBlocked: false, blockedAt: null })), findMany: vi.fn(async () => []) },
    scopedPrivilegeAssignment: {findMany: vi.fn(async () => [])},
    project: { findUnique: vi.fn(async () => ({
      id: "project", ownerId: options.watcher ? "other" : "actor", members: [],
      departmentId: "dept", responsibleGroupId: "group",
      department: { id: "dept", leaderId: "leader", archivedAt: null },
      responsibleGroup: { id: "group", archivedAt: null, members: options.groupMember ? [{ userId: "actor" }] : [] },
    })) },
    taskRequest: {
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
    task: {
      findFirst: vi.fn(async () => options.taskAccess === false && !(options.watcher && options.watcherInsideTx !== false) ? null : {id:"task"}),
      findUnique: vi.fn(async () => ({ id:"task", projectId:"project", title:"������������� ������", request:null, assignees:(options.assignees??[]).map(userId=>({userId})), attachments: state.attachments })),
      update: vi.fn(async ({ data }: { data: { attachments: typeof state.attachments } }) => {
        state.attachments = data.attachments;
      }),
    },
    chatMessage: {
      create: vi.fn(async ({ data, include }: { data: Record<string, unknown>; include: unknown }) => {
        if (data.clientId && state.messages.some(message => message.clientId === data.clientId)) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const id = `message-${++sequence}`;
        const message: Message = {
          id,
          clientId: data.clientId as string | null | undefined,
          taskId: data.taskId as string,
          authorId: data.authorId as string,
          contentText: data.contentText as string,
          attachments: data.attachments as unknown[],
          createdAt: new Date(),
        };
        state.messages.push(message);
        return { ...message, author: include ? publicAuthor : undefined };
      }),
    },
  };

  const database = {
    taskRequest: { findUnique: vi.fn(async () => options.requestMarker ?? null) },
    task: {
      findFirst: vi.fn(async () => options.taskAccess === false && !options.watcher ? null : { id: "task", projectId: "project" }),
      findUnique: vi.fn(async () => ({
        id: "task",
        projectId: "project",
        title: "Синтетическая заявка",
        request: null,
        assignees: (options.assignees ?? []).map(userId => ({ userId })),
      })),
    },
    project: {
      findMany: vi.fn(async () => [{ id: "project" }]),
      findUnique: vi.fn(async () => options.factsAvailable === false ? null : {
        id: "project", ownerId: options.legacyWrite ? "actor" : "other", members: [],
        departmentId: "dept",
        responsibleGroupId: "group",
        department: { id: "dept", leaderId: "leader", archivedAt: null },
        responsibleGroup: {
          id: "group",
          archivedAt: null,
          members: options.groupMember ? [{ userId: "actor" }] : [{ userId: "member" }],
        },
      }),
    },
    user: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, globalRole: where.id === "actor" ? options.role ?? "USER" : "USER", isBlocked: false, blockedAt: null })),
    },
    scopedPrivilegeAssignment: { findMany: vi.fn(async () => []) },
    chatMessage: {
      findMany: vi.fn(async (query: { where?: { id?: { notIn?: string[] } } }) => {
        const hidden = new Set(query.where?.id?.notIn ?? []);
        return state.messages
          .filter(message => !hidden.has(message.id))
          .map(message => ({ ...message, author: publicAuthor }))
          .reverse();
      }),
      findUnique: vi.fn(async ({ where }: { where: { clientId: string } }) => {
        const message = state.messages.find(item => item.clientId === where.clientId);
        return message ? { ...message, author: publicAuthor } : null;
      }),
      create: vi.fn(() => { throw new Error("MUST_USE_TX_INSERT"); }),
    },
    $queryRaw: vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join("?");
      if (sql.includes("TaskWatcher")) {
        if (sql.includes('"userId" =')) return options.watcher ? [{ userId: "actor" }] : [];
        return (options.watchers ?? []).map(userId => ({ userId }));
      }
      if (sql.includes('"isInternal"')) {
        if (options.internalStorageFailure) throw new Error("connection reset");
        if (options.internalColumnMissing) {
          throw Object.assign(new Error("Raw query failed"), { code: "P2010", meta: { code: "42703" } });
        }
        expect(values).toEqual(["task"]);
        return [...state.internalIds].map(id => ({ id }));
      }
      return [];
    }),
    $executeRaw: executeRaw,
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => {
      const snapshot = structuredClone(state);
      try {
        return await callback(tx);
      } catch (error) {
        state.messages = snapshot.messages;
        state.internalIds = snapshot.internalIds;
        state.attachments = snapshot.attachments;
        throw error;
      }
    },
  };

  runtime.db = database;
  return { state, database, tx };
}

function getRequest(query = "") {
  return GET(new Request(`http://localhost/api/tasks/task/messages${query}`), { params: Promise.resolve({ id: "task" }) });
}

function postRequest(body: unknown) {
  return POST(new Request("http://localhost/api/tasks/task/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: "task" }) });
}

beforeEach(() => {
  runtime.auth.mockReset();
  runtime.rate.mockReset();
  runtime.notify.mockReset();
  runtime.auth.mockResolvedValue({ id: "actor", name: "Actor", globalRole: "USER" });
  runtime.rate.mockResolvedValue(undefined);
  runtime.notify.mockResolvedValue({ count: 0 });
});

describe("GET ordinary/internal discussion", () => {
  it("hides internal rows from an ordinary participant and reports the server decision", async () => {
    const f = fixture({ groupMember: false });
    const response = await getRequest();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.canReadInternal).toBe(false);
    expect(body.data.items.map((item: { id: string }) => item.id)).toEqual(["public-1"]);
    expect(f.database.chatMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { taskId: "task", id: { notIn: ["internal-1"] } },
    }));
  });

  it("returns internal rows and their attachments only to a responsible-group member", async () => {
    const f = fixture({ groupMember: true });
    const response = await getRequest();
    const body = await response.json();
    expect(body.data.canReadInternal).toBe(true);
    expect(body.data.items.map((item: { id: string }) => item.id).sort()).toEqual(["internal-1", "public-1"]);
    expect(body.data.items.find((item: { id: string }) => item.id === "internal-1")).toMatchObject({
      isInternal: true,
      attachments: [],
    });
    expect(f.database.chatMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { taskId: "task" },
    }));
  });

  it("preserves the legacy public discussion before the isInternal migration", async () => {
    const f = fixture({ groupMember: false, internalColumnMissing: true });
    const response = await getRequest();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.canReadInternal).toBe(false);
    expect(body.data.items.map((item: { id: string }) => item.id).sort()).toEqual(["internal-1", "public-1"]);
    expect(body.data.items.every((item: { isInternal: boolean }) => item.isInternal === false)).toBe(true);
    expect(f.database.chatMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { taskId: "task" },
    }));
  });

  it("fails closed instead of widening visibility when internal storage fails", async () => {
    fixture({ internalStorageFailure: true });
    const response = await getRequest();
    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("INTERNAL_ERROR");
  });

  it("lets a persisted watcher from outside the project read the ordinary part of this task", async () => {
    const f = fixture({ taskAccess: false, watcher: true, groupMember: false });
    const response = await getRequest();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items.map((item: { id: string }) => item.id)).toEqual(["public-1"]);
    expect(f.database.task.findFirst).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.database.task.findFirst.mock.calls)).toContain('"watchers":{"some":{"userId":"actor"}}');
    expect(f.database.task.findUnique).not.toHaveBeenCalled();
    expect(body.data.canReadInternal).toBe(false);
  });

  it("still returns 404 to an outsider who is not a watcher", async () => {
    fixture({ taskAccess: false, watcher: false });
    expect((await getRequest()).status).toBe(404);
  });
});

describe("POST comment type", () => {
  const file = { url: "/api/tasks/task/files/00000000-0000-4000-8000-000000000001", name: "internal.txt", size: 4, mime: "text/plain" };

  it("publishes own pending file only with a committed public message and returns clean metadata", async () => {
    const f=fixture({storedAttachments:[{...file,pendingMessageAuthorId:"actor"}]});
    const response=await postRequest({contentText:"Published",attachments:[file]});
    expect(response.status).toBe(201);
    expect((await response.json()).data.attachments).toEqual([file]);
    expect(f.state.attachments).toEqual([file]);
    expect(f.state.messages.at(-1)?.attachments).toEqual([file]);
  });
  it("refuses another actor's pending URL without publishing it or inserting a message", async () => {
    const staged={...file,pendingMessageAuthorId:"other"};
    const f=fixture({storedAttachments:[staged]});
    const response=await postRequest({contentText:"Publish",attachments:[file]});
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(f.tx.chatMessage.create).not.toHaveBeenCalled();
    expect(f.state.attachments).toEqual([staged]);
  });
  it("rolls own pending publication back when message insert fails", async () => {
    const staged={...file,pendingMessageAuthorId:"actor"};
    const f=fixture({storedAttachments:[staged]});
    f.tx.chatMessage.create.mockRejectedValueOnce(new Error("synthetic-insert-failure"));
    expect((await postRequest({contentText:"Publish",attachments:[file]})).status).toBe(500);
    expect(f.state.attachments).toEqual([staged]);
  });
  it("inherits internal visibility in both the message and file metadata in the same transaction", async () => {
    const f = fixture({ groupMember: true, markSucceeds: true, storedAttachments: [file] });
    const response = await postRequest({ visibility: "INTERNAL", attachments: [file] });
    expect(response.status).toBe(201);
    expect((await response.json()).data.attachments).toEqual([file]);
    expect(f.state.attachments).toEqual([{ ...file, isInternal: true }]);
    expect(f.tx.task.update).toHaveBeenCalledOnce();
  });

  it("rolls file visibility back with a failed internal message flag", async () => {
    const f = fixture({ groupMember: true, markSucceeds: false, storedAttachments: [file] });
    expect((await postRequest({ visibility: "INTERNAL", attachments: [file] })).status).toBe(500);
    expect(f.state.attachments).toEqual([file]);
    expect(f.state.messages).toHaveLength(2);
  });

  it("refuses to publish an existing internal file through an ordinary message", async () => {
    const f = fixture({ storedAttachments: [{ ...file, isInternal: true }] });
    expect((await postRequest({ attachments: [file] })).status).toBe(422);
    expect(f.tx.chatMessage.create).not.toHaveBeenCalled();
    expect(f.tx.task.update).not.toHaveBeenCalled();
  });

  it("does not replay a former author's internal content after their internal role is revoked", async () => {
    const f = fixture({ groupMember: false, messages: [{
      id: "internal-1", clientId: "same", taskId: "task", authorId: "actor",
      contentText: "Restricted", attachments: [{ ...file, isInternal: true }], createdAt: new Date(),
    }] });
    const response = await postRequest({ clientId: "same", contentText: "Public retry" });
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain("Restricted");
    expect(f.state.messages).toHaveLength(1);
    expect(runtime.notify).not.toHaveBeenCalled();
  });

  it("rejects an internal comment from an author/watcher without an internal role before any write", async () => {
    const f = fixture({ groupMember: false });
    const response = await postRequest({ contentText: "Internal", visibility: "INTERNAL" });
    expect(response.status).toBe(403);
    expect(f.tx.chatMessage.create).not.toHaveBeenCalled();
    expect(f.database.$executeRaw).not.toHaveBeenCalled();
    expect(f.state.messages).toHaveLength(2);
  });

  it("stores an internal comment for a responsible-group member and never publishes it as ordinary", async () => {
    const f = fixture({ groupMember: true, markSucceeds: true });
    const response = await postRequest({ contentText: "Internal", visibility: "INTERNAL" });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data).toMatchObject({ isInternal: true, contentText: "Internal" });
    expect(f.database.$executeRaw).toHaveBeenCalledTimes(1);
    expect(f.state.internalIds.has(body.data.id)).toBe(true);
    expect(runtime.emit).toHaveBeenCalledExactlyOnceWith("project", expect.objectContaining({ id: body.data.id, visibility: "INTERNAL", isInternal: true }));
  });

  it("rolls the message back when the internal flag cannot be persisted", async () => {
    const f = fixture({ groupMember: true, markSucceeds: false });
    const response = await postRequest({ contentText: "Internal", visibility: "INTERNAL" });
    expect(response.status).toBe(500);
    expect(f.state.messages).toHaveLength(2);
    expect(f.state.internalIds.has("message-1")).toBe(false);
    expect(runtime.emit).not.toHaveBeenCalled();
  });

  it("rejects conflicting visibility spellings before authentication", async () => {
    fixture();
    const response = await postRequest({ contentText: "Text", visibility: "INTERNAL", isInternal: false });
    expect(response.status).toBe(422);
    expect(runtime.auth).not.toHaveBeenCalled();
  });

  it("keeps ordinary comments public by default and notifies only the configured recipients", async () => {
    const f = fixture({ assignees: ["assignee"], watchers: ["watcher"] });
    const response = await postRequest({ contentText: "Public" });
    expect(response.status).toBe(201);
    expect((await response.json()).data.isInternal).toBe(false);
    expect(f.database.$executeRaw).not.toHaveBeenCalled();
    expect(runtime.notify).toHaveBeenCalledTimes(1);
    const rows = runtime.notify.mock.calls[0]?.[0] as Array<{ userId: string }>;
    expect(rows.map(row => row.userId)).toEqual(["assignee", "watcher"]);
  });

  it("does not deliver internal notifications to assignees/watchers outside the internal part", async () => {
    fixture({ groupMember: true, markSucceeds: true, assignees: ["assignee"], watchers: ["watcher"] });
    const response = await postRequest({ contentText: "Internal", visibility: "INTERNAL" });
    expect(response.status).toBe(201);
    const rows = runtime.notify.mock.calls[0]?.[0] as Array<{ userId: string }>;
    // Neither subscribed legacy recipient can read the internal part.
    // Department leadership is not an implicit subscription.
    expect(rows.map(row => row.userId)).toEqual([]);
  });

  it("returns the committed message for an idempotent clientId replay without duplicates", async () => {
    const f = fixture();
    const first = await postRequest({ clientId: "same", contentText: "Once" });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const second = await postRequest({ clientId: "same", contentText: "Once" });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.data.id).toBe(firstBody.data.id);
    expect(f.state.messages.filter(message => message.clientId === "same")).toHaveLength(1);
    expect(runtime.notify).toHaveBeenCalledTimes(1);
    expect(runtime.emit).toHaveBeenCalledTimes(1);
  });

  it("keeps authentication and rate-limit boundaries", async () => {
    fixture();
    runtime.auth.mockRejectedValueOnce(new UnauthorizedError());
    expect((await postRequest({ contentText: "Text" })).status).toBe(401);
    runtime.rate.mockRejectedValueOnce(new Error("limit"));
    expect((await postRequest({ contentText: "Text" })).status).toBe(429);
  });
});

describe("watcher comments", () => {
  it("allows a persisted watcher to write ordinary content through the shared task policy", async () => {
    const f = fixture({ taskAccess: false, watcher: true });
    const response = await postRequest({ contentText: "?? ???????????" });
    expect(response.status).toBe(201);
    expect(f.tx.chatMessage.create).toHaveBeenCalledOnce();
    expect(f.database.$executeRaw).not.toHaveBeenCalled();
    expect(f.state.messages).toHaveLength(3);
    const statements = f.tx.$queryRaw.mock.calls.map(([parts]: [TemplateStringsArray]) => parts.join("?"));
    expect(statements.some(sql => sql.includes('FROM "Task"') && sql.includes("FOR UPDATE"))).toBe(true);
    expect(statements.some(sql => sql.includes('FROM "TaskWatcher"') && sql.includes("FOR SHARE"))).toBe(true);
  });

  it("denies a watcher whose row was revoked before the transaction", async () => {
    const f = fixture({ taskAccess: false, watcher: true, watcherInsideTx: false });
    const response = await postRequest({ contentText: "От наблюдателя" });
    expect(response.status).toBe(404);
    expect(f.tx.chatMessage.create).not.toHaveBeenCalled();
    expect(f.state.messages).toHaveLength(2);
  });

  it("does not grant the internal part to a watcher-only participant", async () => {
    const f = fixture({ taskAccess: false, watcher: true });
    const response = await postRequest({ contentText: "Секрет", visibility: "INTERNAL" });
    expect(response.status).toBe(403);
    expect(f.tx.chatMessage.create).not.toHaveBeenCalled();
  });
});

it("returns a safe tombstone and keeps a legacy read-only author's own controls disabled", async () => {
  fixture({ internalIds: [], messages: [{ id: "removed", taskId: "task", authorId: "actor", contentText: "Secret-before", attachments: [{ url: "/hidden-file" }], mentions: ["recipient"], reactions: { ok: ["recipient"] }, version: 1, deletedAt: new Date(), createdAt: new Date() },
    { id: "own", taskId: "task", authorId: "actor", contentText: "Visible", attachments: [], version: 0, deletedAt: null, createdAt: new Date() }] });
  const response = await getRequest(); expect(response.status).toBe(200); const rows = (await response.json()).data.items;
  expect(rows.find((row: { id: string }) => row.id === "removed")).toMatchObject({ contentText: "", attachments: [], mentions: [], reactions: {}, canEdit: false, canDelete: false });
  expect(rows.find((row: { id: string }) => row.id === "own")).toMatchObject({ canEdit: false, canDelete: false, version: 0 });
});

it.each(["SUBMITTED","IN_PROGRESS","NEEDS_INFO","COMPLETED","CLOSED","CANCELLED"])("projects own canonical message controls from current %s content state", async state => {
  fixture({ watcher: true, internalIds: [], requestMarker: { state, authorId: "author", contractVersion: 1, deletedAt: null }, messages: [{ id: "own", taskId: "task", authorId: "actor", contentText: "Own", attachments: [], version: 0, deletedAt: null, createdAt: new Date() }] });
  const response=await getRequest();expect(response.status).toBe(200);expect((await response.json()).data.items[0]).toMatchObject({ canEdit: state !== "CANCELLED", canDelete: state !== "CANCELLED", version: 0 });
});
it("retains a writable legacy author's correction controls", async () => {
  fixture({ legacyWrite: true, internalIds: [], messages: [{ id: "own", taskId: "task", authorId: "actor", contentText: "Own", attachments: [], version: 0, deletedAt: null, createdAt: new Date() }] });
  const response=await getRequest();expect(response.status).toBe(200);expect((await response.json()).data.items[0]).toMatchObject({canEdit:true,canDelete:true});
});
