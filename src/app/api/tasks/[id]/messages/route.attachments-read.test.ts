import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachmentFileUrl } from "@/lib/attachments/task-port";

const runtime = vi.hoisted(() => ({ db: {} as object, auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_, key) => Reflect.get(runtime.db, key) }) }));
vi.mock("@/lib/require-api-user", () => ({ requireApiUser: runtime.auth, UnauthorizedError: class extends Error {} }));
vi.mock("@/lib/rate-limit", () => ({ rateLimitOrThrowKey: vi.fn(), rateLimitErrorResponse: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn() }));
import { GET } from "./route";

const file = (suffix: "1" | "2" = "1") => ({
  url: attachmentFileUrl("task", `0a6e3b9e-3dcb-402e-891a-d1074b75d40${suffix}`),
  name: "current-name.pdf", mime: "application/pdf", size: 42,
});
const message = (id: string, attachments: unknown) => ({
  id, taskId: "task", authorId: "author", contentText: "Public text stays visible",
  attachments, createdAt: new Date("2026-10-24T12:00:00Z"),
});
function fixture() {
  const state = {
    member: false, archived: false, taskRead: true, missingMetadata: false, metadataProject: "project",
    metadata: [file()] as unknown, messages: [message("message", [file()])], afterMessages: undefined as (() => void) | undefined,
  };
  const db = {
    taskRequest: { findUnique: vi.fn(async () => null) },
    task: {
      findFirst: vi.fn(async () => state.taskRead ? { id: "task", projectId: "project" } : null),
      findUnique: vi.fn(async () => state.missingMetadata ? null : { id: "task", projectId: state.metadataProject, attachments: state.metadata }),
    },
    project: {
      findMany: vi.fn(async () => []), // Task-only watcher; no readable board grant.
      findUnique: vi.fn(async () => ({ id: "project", ownerId: "other", members: [], departmentId: null, responsibleGroupId: "group", department: null,
        responsibleGroup: { id: "group", archivedAt: state.archived ? new Date("2026-10-24") : null,
          members: state.member ? [{ userId: "watcher" }] : [] } })),
    },
    user: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => ({ id: "watcher", globalRole: "USER" })) },
    scopedPrivilegeAssignment: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
    chatMessage: { findMany: vi.fn(async ({ take }: { take: number }) => {
      state.afterMessages?.(); return state.messages.slice(0, take);
    }) },
  };
  runtime.db = db;
  return { state, db };
}
let f: ReturnType<typeof fixture>;
beforeEach(() => {
  vi.resetAllMocks(); f = fixture(); runtime.auth.mockResolvedValue({ id: "watcher", globalRole: "USER" });
});
async function request(query = "") {
  const response = await GET(new Request(`https://app.test/api/tasks/task/messages${query}`), { params: Promise.resolve({ id: "task" }) });
  return { response, body: await response.json() };
}

describe("GET message files use current task audience and metadata", () => {
  it("keeps a public message but hides its file promoted to INTERNAL from a task-only watcher", async () => {
    f.state.messages = [message("public-message", [{ ...file(), name: "historical-private-name.pdf" }])];
    f.state.metadata = [{ ...file(), isInternal: true }];
    const { response, body } = await request();
    expect(response.status).toBe(200);
    expect(body.data.items[0]).toMatchObject({ id: "public-message", contentText: "Public text stays visible", attachments: [] });
    expect(JSON.stringify(body)).not.toContain(file().url);
    expect(JSON.stringify(body)).not.toContain("historical-private-name");
    expect(f.db.task.findFirst).toHaveBeenCalledWith(expect.objectContaining({ select: { id: true, projectId: true } }));
  });

  it("returns only current canonical DTO to an active internal-group reader", async () => {
    f.state.member = true;
    const canonical = { ...file(), isInternal: true, width: 30 };
    f.state.metadata = [canonical];
    f.state.messages = [message("message", [{ ...file(), name: "stale.pdf", size: 1, mime: "stale/type" }])];
    const { body } = await request();
    expect(body.data.items[0].attachments).toEqual([canonical]);
  });

  it.each(["revoked", "archived"])("does not retain file rights when group membership becomes %s during the read", async change => {
    f.state.member = true; f.state.metadata = [{ ...file(), isInternal: true }];
    f.state.afterMessages = () => { if (change === "revoked") f.state.member = false; else f.state.archived = true; };
    const { body } = await request();
    expect(body.data.items[0].attachments).toEqual([]);
  });

  it("projects mixed files against current metadata and retains message order/cursor", async () => {
    const current = { ...file(), name: "renamed-current.pdf", size: 75 };
    f.state.metadata = [current, { ...file("2"), isInternal: true }];
    f.state.messages = [message("newest", [file(), file("2")]), message("middle", [file()]), message("older", [])];
    const { body } = await request("?limit=2");
    expect(body.data.items.map((row: { id: string }) => row.id)).toEqual(["middle", "newest"]);
    expect(body.data.nextCursor).toBe("middle");
    expect(body.data.items.map((row: { attachments: unknown[] }) => row.attachments)).toEqual([[current], [current]]);
  });

  it("retains a valid current public legacy URL while replacing stale fields", async () => {
    const legacy = { ...file(), url: "/legacy/approved-public-file", name: "current-legacy.pdf" };
    f.state.metadata = [legacy]; f.state.messages = [message("message", [{ ...legacy, name: "stale.pdf" }])];
    const { body } = await request();
    expect(body.data.items[0].attachments).toEqual([legacy]);
  });

  it.each(["missing", "malformed", "foreign-project", "foreign-file", "orphan"])("fails closed for %s current file metadata without hiding public text", async reason => {
    if (reason === "missing") f.state.missingMetadata = true;
    if (reason === "malformed") f.state.metadata = [{ url: file().url, name: "invalid", size: "bad", mime: "x" }];
    if (reason === "foreign-project") f.state.metadataProject = "other-project";
    if (reason === "foreign-file") {
      const foreign = { ...file(), url: file().url.replace("/task/", "/other-task/") };
      f.state.metadata = [foreign]; f.state.messages = [message("message", [foreign])];
    }
    if (reason === "orphan") f.state.metadata = [];
    const { body } = await request();
    expect(body.data.items[0]).toMatchObject({ contentText: "Public text stays visible", attachments: [] });
  });

  it("cannot turn duplicate public metadata into access to an internal URL", async () => {
    f.state.metadata = [file(), { ...file(), isInternal: true }];
    const { body } = await request();
    expect(body.data.items[0].attachments).toEqual([]);
  });

  it("preserves common task-read rejection and never loads messages or file metadata", async () => {
    f.state.taskRead = false;
    const { response } = await request();
    expect(response.status).toBe(404);
    expect(f.db.chatMessage.findMany).not.toHaveBeenCalled();
    expect(f.db.task.findUnique).not.toHaveBeenCalled();
  });
});
