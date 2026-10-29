import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ findFirst: vi.fn(), readWhere: vi.fn(), requireDbUser: vi.fn(), arrivals: vi.fn() }));
vi.mock("@/lib/request-queue-unseen", () => ({ readRequestQueueArrivalMap: db.arrivals }));
vi.mock("@/lib/prisma", () => ({ prisma: { task: { findFirst: db.findFirst } } }));
vi.mock("@/lib/require-user", () => ({ requireDbUser: db.requireDbUser }));
vi.mock("@/lib/project-access", () => ({ getTaskReadWhere: db.readWhere }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("@/app/(dashboard)/projects/[id]/tasks/[taskId]/TaskDetailPage", () => ({ TaskDetailPage: () => null }));
vi.mock("@/app/(dashboard)/projects/[id]/board/@modal/(..)tasks/[taskId]/TaskModalPage", () => ({ TaskModalPage: () => null }));

import TaskPage from "@/app/(dashboard)/projects/[id]/tasks/[taskId]/page";
import TaskModalPage from "@/app/(dashboard)/projects/[id]/board/@modal/(..)tasks/[taskId]/page";

function storedTask() {
  return {
    id: "task-1", title: "Task", description: "Description", status: "TODO", priority: "HIGH",
    position: 1, version: 4, rank: "abc", projectId: "project-1", columnId: "column-1", createdById: null,
    deadline: new Date("2026-09-18T12:00:00Z"), createdAt: new Date("2026-09-01T12:00:00Z"), updatedAt: new Date("2026-09-02T12:00:00Z"),
    attachments: [{ url: "https://example.test/a.pdf", name: "a.pdf", size: 42, mime: "application/pdf" }],
    assignees: [{ id: "assignment-1", user: { id: "user-1", name: "User", email: "user@example.test", avatarUrl: null, passwordHash: "private-hash", futurePrivateField: "private-secret" } }],
    tags: [{ id: "task-tag-1", tag: { id: "tag-1", name: "Tag", color: "#ffffff", createdAt: new Date() } }],
    checklistItems: [{ id: "check-1", taskId: "task-1", text: "Check", completed: false, position: 0, createdAt: new Date("2026-09-01T12:00:00Z"), updatedAt: new Date("2026-09-02T12:00:00Z") }],
  };
}
const props = () => ({ params: Promise.resolve({ id: "project-1", taskId: "task-1" }), searchParams: Promise.resolve({ tab: "chat", msg: "message-1" }) });

it.each([TaskModalPage, TaskPage])("binds the server snapshot to the authenticated actor for hydration", async page => {
  const result = await page(props());
  expect(result.props.initialActorId).toBe("user-1");
});

beforeEach(() => {
  vi.resetAllMocks();
  db.requireDbUser.mockResolvedValue({ id: "user-1", globalRole: "USER" });
  db.readWhere.mockImplementation(async (_user, filters) => ({ AND: [{ policy: "task-read" }, filters] }));
  db.findFirst.mockResolvedValue(storedTask());
  db.arrivals.mockResolvedValue(new Map([["task-1", { epoch: 6, unseen: true }]]));
});

describe.each([{ name: "detail", page: TaskPage }, { name: "modal", page: TaskModalPage }])("$name server task DTO", ({ page }) => {
  it("projects only public user fields in the database query and client props", async () => {
    const result = await page(props());
    expect(db.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { AND: [{ policy: "task-read" }, { id: "task-1" }] },
      include: expect.objectContaining({ assignees: { include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } } } }),
    }));
    expect(result.props.task.assignees).toEqual([{ id: "assignment-1", user: { id: "user-1", name: "User", email: "user@example.test", avatarUrl: null } }]);
    expect(result.props.task.queueArrival).toEqual({ epoch: 6, unseen: true });
    expect(db.arrivals).toHaveBeenCalledWith(expect.anything(), "user-1", ["task-1"]);
    expect(JSON.stringify(result.props)).not.toContain("private-");
  });

  it("serializes timestamps and preserves deadline, attachments and route context", async () => {
    const result = await page(props());
    expect(result.props).toMatchObject({ projectId: "project-1", taskId: "task-1", initialTab: "chat", messageId: "message-1" });
    expect(result.props.task).toMatchObject({ createdAt: "2026-09-01T12:00:00.000Z", updatedAt: "2026-09-02T12:00:00.000Z", createdById: undefined, version: 4, deadline: new Date("2026-09-18T12:00:00Z"), attachments: storedTask().attachments });
    expect(result.props.task.checklistItems[0]).toMatchObject({ createdAt: "2026-09-01T12:00:00.000Z", updatedAt: "2026-09-02T12:00:00.000Z" });
    expect(result.props.task.tags).toEqual([{ id: "task-tag-1", tag: { id: "tag-1", name: "Tag", color: "#ffffff" } }]);
  });

  it("ignores malformed JSON attachment entries without losing valid attachments", async () => {
    db.findFirst.mockResolvedValue({ ...storedTask(), attachments: [null, { url: 2 }, ...storedTask().attachments] });
    const result = await page(props());
    expect(result.props.task.attachments).toEqual(storedTask().attachments);
  });

  it("does not return a task from another project", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.findFirst.mockResolvedValue({ ...storedTask(), projectId: "other-project" });
    await expect(page(props())).rejects.toThrow("NOT_FOUND");
  });

  it("does not render a task the shared predicate hides, even for a project reader", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The real predicate returns no row for a task outside the caller's
    // author/executor/watcher/group scope; the page must treat that as absent.
    db.findFirst.mockResolvedValue(null);
    await expect(page(props())).rejects.toThrow("NOT_FOUND");
    expect(db.readWhere).toHaveBeenCalledWith({ id: "user-1", globalRole: "USER" }, { id: "task-1" });
    expect(db.findFirst).toHaveBeenCalledOnce();
  });

  it("returns 404 after a queue projection revocation and never renders stale actor data", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.arrivals.mockResolvedValueOnce(new Map());
    await expect(page(props())).rejects.toThrow("NOT_FOUND");
  });

  it("projects a readable draft without recording a view or removing direct access", async () => {
    db.findFirst.mockResolvedValue({ ...storedTask(), request: { state: "DRAFT", executorId: null, audienceUserIds: [], author: null, executor: null } });
    db.arrivals.mockResolvedValueOnce(new Map([["task-1", { epoch: 0, unseen: false }]]));
    const result = await page(props());
    expect(result.props.task.request.state).toBe("DRAFT");
    expect(result.props.task.queueArrival).toEqual({ epoch: 0, unseen: false });
  });
});
