import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ arrivals: vi.fn(), actor: vi.fn(), attachments: vi.fn(), counts: vi.fn() }));
vi.mock("./prisma", () => ({ prisma: { user: { findUnique: mocks.actor } } }));
vi.mock("./request-queue-unseen", () => ({ readRequestQueueArrivalMap: mocks.arrivals }));
vi.mock("./attachments/task-port", async original => ({ ...await original<typeof import("./attachments/task-port")>(), readVisibleTaskAttachments: mocks.attachments }));
vi.mock("./task-visible-message-counts", () => ({ readVisibleMessageCounts: mocks.counts }));
import { projectTaskRealtimeForReader } from "./task-queries";

const run = (data: unknown, actorId = "actor") => projectTaskRealtimeForReader(actorId, "task", "board", data);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.arrivals.mockResolvedValue(new Map([["task", { epoch: 2, unseen: true }]]));
  mocks.actor.mockResolvedValue({ id: "actor", globalRole: "USER" });
  mocks.attachments.mockResolvedValue([]);
  mocks.counts.mockResolvedValue(new Map([["task", { total: 0, unread: 0 }]]));
});

describe("per-reader queue arrival projection before attachment shortcuts", () => {
  it("replaces unrestricted room counters with the current reader's visible counts", async () => {
    mocks.counts.mockResolvedValueOnce(new Map([["task", { total: 2, unread: 1 }]]));
    const result = await run({ id: "task", projectId: "board", _count: { messages: 999, checklistItems: 3 }, unreadCount: 999 });
    expect(result).toMatchObject({ _count: { messages: 2, checklistItems: 3 }, unreadCount: 1 });
    expect(mocks.counts).toHaveBeenCalledExactlyOnceWith(expect.anything(), { id: "actor", globalRole: "USER" }, ["task"]);
  });

  it("suppresses room data when the count reader sees revocation and never falls back to raw counts", async () => {
    mocks.counts.mockResolvedValueOnce(new Map());
    expect(await run({ id: "task", projectId: "board", _count: { messages: 999 }, unreadCount: 999 })).toBeNull();
    mocks.counts.mockRejectedValueOnce(new Error("synthetic count failure"));
    await expect(run({ id: "task", projectId: "board", _count: { messages: 999 } })).rejects.toThrow("synthetic count failure");
  });

  it.each([{}, { attachments: [] }, { attachments: [{ name: "photo.png", url: "/api/files/photo", mime: "image/png", size: 1 }] }])("projects fresh actor data for missing or public-only attachments %j", async extra => {
    const result = await run({ id: "task", projectId: "board", queueArrival: { epoch: 99, unseen: false }, ...extra });
    expect(result).toMatchObject({ id: "task", queueArrival: { epoch: 2, unseen: true } });
    expect(mocks.arrivals).toHaveBeenCalledOnce();
  });
  it("returns the other reader's own state, never the first recipient's projection", async () => {
    const first = await run({ id: "task", projectId: "board" });
    mocks.arrivals.mockResolvedValueOnce(new Map([["task", { epoch: 2, unseen: false }]]));
    const second = await run(first, "other-actor");
    expect(second).toMatchObject({ queueArrival: { epoch: 2, unseen: false } });
    expect(mocks.arrivals.mock.calls[1][1]).toBe("other-actor");
  });
  it("retains attachment ACL filtering and adds arrival data on the internal path", async () => {
    const result = await run({ id: "task", projectId: "board", attachments: [{ name: "internal.txt", url: "/api/files/private", mime: "text/plain", size: 1, isInternal: true }] });
    expect(result).toMatchObject({ attachments: [], queueArrival: { epoch: 2, unseen: true } });
    expect(mocks.attachments).toHaveBeenCalledOnce();
  });
  it("suppresses delivery for a missing/revoked reader even without attachments", async () => {
    mocks.arrivals.mockResolvedValueOnce(new Map());
    expect(await run({ id: "task", projectId: "board", queueArrival: { epoch: 2, unseen: true } })).toBeNull();
  });
  it("does not return an unprojected payload when projection errors", async () => {
    mocks.arrivals.mockRejectedValueOnce(new Error("read failed"));
    await expect(run({ id: "task", projectId: "board" })).rejects.toThrow("read failed");
  });
  it.each([null, [], "payload", { id: "other", projectId: "board" }, { id: "task", projectId: "other" }])("suppresses an invalid/mismatched snapshot %j", async value => {
    expect(await run(value)).toBeNull();
    expect(mocks.arrivals).not.toHaveBeenCalled();
  });
  it("retains null for a freshly authorized legacy task", async () => {
    mocks.arrivals.mockResolvedValueOnce(new Map([["task", null]]));
    expect(await run({ id: "task", projectId: "board" })).toMatchObject({ queueArrival: null });
  });
});
