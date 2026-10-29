import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTaskReadWhere } from "@/lib/project-access";
import {
  attachmentBelongsToTask,
  attachmentFileUrl,
  parseStoredAttachments,
  readTaskAttachmentAccess,
  readVisibleTaskAttachments,
  publicTaskAttachmentDTOs,
  effectiveBeznalPhase,
  type AttachmentReadDatabase,
} from "./task-port";

vi.mock("@/lib/project-access", () => ({ getTaskReadWhere: vi.fn() }));

const fileId = "00000000-0000-4000-8000-000000000001";
const attachment = { url: attachmentFileUrl("task", fileId), name: "private.txt", size: 4, mime: "text/plain" };
const closedMarker = () => ({ taskId: "task", contractVersion: 1, state: "CLOSED", authorId: "author", executorId: "executor", needsInfoSince: null, pausedTotalMs: 0, deletedAt: null });

function fixture() {
  const visible = new Set(["author", "executor", "watcher", "member"]);
  const state = { attachments: [attachment] as Array<typeof attachment & { isInternal?: boolean; pendingMessageAuthorId?: string }>, groupActive: true,
    request: null as Record<string, unknown> | null };
  const user = { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (
    where.id === "deleted" ? null : { id: where.id, globalRole: "USER" }
  )) };
  const task = { findFirst: vi.fn(async ({ where }: { where: { id: string; creatorId: string } }) => (
    visible.has(where.creatorId) ? { id: "task", projectId: "board", attachments: state.attachments, request: state.request } : null
  )) };
  const database = {
    user: { ...user, findMany: vi.fn(async () => []) }, task,
    taskRequest: { findUnique: vi.fn(async () => state.request && Object.fromEntries(Object.entries(state.request).filter(([key]) => !["deletedAt", "needsInfoSince", "pausedTotalMs"].includes(key)))) },
    project: { findUnique: vi.fn(async () => ({
      id: "board", departmentId: null, department: null, responsibleGroupId: "group",
      responsibleGroup: { id: "group", archivedAt: state.groupActive ? null : new Date(), members: [{ userId: "member" }] },
    })) },
    scopedPrivilegeAssignment: { findMany: vi.fn(async () => []) },
  } as unknown as AttachmentReadDatabase;
  vi.mocked(getTaskReadWhere).mockImplementation(async (actor, filters) => ({ ...filters, creatorId: actor.id }));
  return { database, user, task, visible, state };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("attachment read authorization", () => {
  it("uses the explicit BezNal phase and only safe published public files for the legacy fallback", () => {
    expect(effectiveBeznalPhase("WAITING", [attachment])).toBe("WAITING");
    expect(effectiveBeznalPhase("INVOICED", [])).toBe("INVOICED");
    expect(effectiveBeznalPhase(null, [attachment])).toBe("INVOICED");
    expect(effectiveBeznalPhase("INVALID", [attachment])).toBe("WAITING");
    for (const raw of [[{ ...attachment, pendingMessageAuthorId: "author" }], [{ ...attachment, isInternal: true }],
      [attachment, { ...attachment, pendingMessageAuthorId: "author" }]]) {
      expect(effectiveBeznalPhase(null, raw)).toBe("WAITING");
    }
  });
  it("keeps staged metadata and known download URLs exclusive to the uploader until publication", async () => {
    const { database, state } = fixture();
    state.attachments = [{ ...attachment, pendingMessageAuthorId: "author" }];
    const own = await readVisibleTaskAttachments(database, { id: "author", globalRole: "USER" }, "board", state.attachments);
    expect(own).toEqual([attachment]);
    expect(JSON.stringify(own)).not.toContain("pendingMessageAuthorId");
    expect(await readTaskAttachmentAccess(database, "task", "author")).toMatchObject({ attachments: state.attachments });
    for (const reader of ["executor", "watcher", "member"]) {
      const result = await readTaskAttachmentAccess(database, "task", reader);
      expect(result).toMatchObject({ attachments: [] });
      if (result.status === "ok") expect(attachmentBelongsToTask(result.attachments, "task", fileId)).toBeNull();
    }
    expect(await readVisibleTaskAttachments(database, { id: "administrator", globalRole: "ADMIN" }, "board", state.attachments)).toEqual([]);
    expect(publicTaskAttachmentDTOs(state.attachments)).toEqual([]);
    // The message transaction's resulting PUBLIC metadata makes the same URL
    // downloadable through the existing fresh task-read boundary.
    state.attachments = [attachment];
    expect(await readTaskAttachmentAccess(database, "task", "executor")).toMatchObject({ attachments: [attachment] });
    // INTERNAL publication retains the separate audience on that same URL.
    state.attachments = [{ ...attachment, isInternal: true }];
    expect(await readTaskAttachmentAccess(database, "task", "executor")).toMatchObject({ attachments: [] });
    expect(await readTaskAttachmentAccess(database, "task", "member")).toMatchObject({ attachments: state.attachments });
  });

  it("hides pending URLs through duplicate public metadata and fails closed for malformed staging owners", async () => {
    const { database, state } = fixture();
    state.attachments = [attachment, { ...attachment, pendingMessageAuthorId: "author" }];
    expect(publicTaskAttachmentDTOs(state.attachments)).toEqual([]);
    expect(await readVisibleTaskAttachments(database, { id: "executor", globalRole: "USER" }, "board", state.attachments)).toEqual([]);
    const malformed = [null, false, 7, "", "bad owner"];
    for (const pendingMessageAuthorId of malformed) {
      const raw = [{ ...attachment, pendingMessageAuthorId }];
      expect(parseStoredAttachments(raw)[0].pendingMessageAuthorId).toBe("");
      expect(publicTaskAttachmentDTOs(raw)).toEqual([]);
      expect(await readVisibleTaskAttachments(database, { id: "author", globalRole: "USER" }, "board", raw)).toEqual([]);
    }
  });

  it("retains internal URL dominance even for a matching staged uploader", async () => {
    const { database } = fixture();
    const raw = [{ ...attachment, pendingMessageAuthorId: "author" }, { ...attachment, isInternal: true }];
    expect(await readVisibleTaskAttachments(database, { id: "author", globalRole: "USER" }, "board", raw)).toEqual([]);
  });

  it.each(["author", "executor", "member"])("reads ordinary CLOSED request attachments for the currently authorized %s", async actor => {
    const { database, state } = fixture();
    state.request = closedMarker();
    expect(await readTaskAttachmentAccess(database, "task", actor)).toMatchObject({ status: "ok", attachments: [attachment] });
  });
  it.each([
    { taskId: "foreign-task" }, { contractVersion: 2 }, { state: "UNKNOWN" }, { executorId: null },
    { needsInfoSince: new Date() }, { pausedTotalMs: -1 }, { extra: "untrusted" },
  ])("fails closed on an invalid or mismatched persisted marker %j", async patch => {
    const { database, state } = fixture();
    state.request = { ...closedMarker(), ...patch };
    expect(await readTaskAttachmentAccess(database, "task", "author")).toEqual({ status: "denied", code: "INVALID_REQUEST_MARKER" });
  });
  it("hides a deleted marked request even if the common read predicate returned it", async () => {
    const { database, state } = fixture();
    state.request = { ...closedMarker(), deletedAt: new Date() };
    expect(await readTaskAttachmentAccess(database, "task", "author")).toEqual({ status: "missing" });
  });
  it.each(["author", "executor", "member"])("retains internal attachment audience for CLOSED reader %s", async actor => {
    const { database, state } = fixture();
    state.request = closedMarker(); state.attachments = [{ ...attachment, isInternal: true }];
    expect(await readTaskAttachmentAccess(database, "task", actor)).toMatchObject({ status: "ok", attachments: actor === "member" ? state.attachments : [] });
  });
  it.each(["author", "watcher"])("denies an internal file to the %s even with a known URL and task read access", async actor => {
    const { database, state } = fixture();
    state.attachments = [attachment, { ...attachment, url: attachmentFileUrl("task", "00000000-0000-4000-8000-000000000002"), isInternal: true }];
    const access = await readTaskAttachmentAccess(database, "task", actor);
    expect(access.status).toBe("ok");
    if (access.status !== "ok") throw new Error("Expected task read");
    expect(access.attachments).toEqual([attachment]);
    expect(attachmentBelongsToTask(access.attachments, "task", "00000000-0000-4000-8000-000000000002")).toBeNull();
  });

  it("rechecks internal group rights on every download and honors revocation", async () => {
    const { database, state } = fixture();
    state.attachments = [{ ...attachment, isInternal: true }];
    expect(await readTaskAttachmentAccess(database, "task", "member")).toMatchObject({ attachments: state.attachments });
    state.groupActive = false;
    expect(await readTaskAttachmentAccess(database, "task", "member")).toMatchObject({ attachments: [] });
  });

  it("fails closed on unavailable internal role facts", async () => {
    const { database, state } = fixture();
    state.attachments = [{ ...attachment, isInternal: true }];
    vi.mocked(database.project.findUnique).mockRejectedValue(new Error("unavailable"));
    expect(await readTaskAttachmentAccess(database, "task", "author")).toMatchObject({ attachments: [] });
  });

  it("cannot download a restricted file through a duplicate public metadata entry", async () => {
    const { database, state } = fixture();
    state.attachments = [attachment, { ...attachment, isInternal: true }];
    expect(await readTaskAttachmentAccess(database, "task", "author")).toMatchObject({ attachments: [] });
  });

  it("preserves server-owned visibility and treats malformed persisted flags as restricted", () => {
    expect(parseStoredAttachments([attachment, { ...attachment, isInternal: true }, { ...attachment, isInternal: "false" }]))
      .toEqual([attachment, { ...attachment, isInternal: true }, { ...attachment, isInternal: true }]);
  });

  it("uses the shared task visibility predicate with a fresh actor before returning metadata", async () => {
    const { database, task } = fixture();
    expect(await readTaskAttachmentAccess(database, "task", "author")).toEqual({
      status: "ok", taskId: "task", projectId: "board", attachments: [attachment],
    });
    expect(getTaskReadWhere).toHaveBeenCalledWith({ id: "author", globalRole: "USER" }, { id: "task" }, database);
    expect(task.findFirst).toHaveBeenCalledWith({
      where: { id: "task", creatorId: "author" },
      select: { id: true, projectId: true, attachments: true, request: { select: {
        taskId: true, contractVersion: true, state: true, authorId: true, executorId: true,
        needsInfoSince: true, pausedTotalMs: true, deletedAt: true,
      } } },
    });
  });

  it("rechecks two actors independently and denies the revoked actor's existing URL", async () => {
    const { database, visible, user, state } = fixture();
    state.request = closedMarker();
    expect((await readTaskAttachmentAccess(database, "task", "author")).status).toBe("ok");
    expect((await readTaskAttachmentAccess(database, "task", "executor")).status).toBe("ok");
    visible.delete("executor");
    expect(await readTaskAttachmentAccess(database, "task", "executor")).toEqual({ status: "missing" });
    expect((await readTaskAttachmentAccess(database, "task", "author")).status).toBe("ok");
    expect(user.findUnique).toHaveBeenCalledTimes(4);
    expect(getTaskReadWhere).toHaveBeenCalledTimes(4);
    expect(database.taskRequest.findUnique).not.toHaveBeenCalled(); // marker and file metadata share the task query
  });

  it("does not inspect task metadata or markers for a deleted actor", async () => {
    const { database, task } = fixture();
    expect(await readTaskAttachmentAccess(database, "task", "deleted")).toEqual({ status: "missing" });
    expect(getTaskReadWhere).not.toHaveBeenCalled();
    expect(task.findFirst).not.toHaveBeenCalled();
    expect(database.taskRequest.findUnique).not.toHaveBeenCalled();
  });

  it("keeps malformed marker refusal authoritative after task visibility passes", async () => {
    const { database, state } = fixture();
    state.request = { taskId: "task", contractVersion: 999, state: "CLOSED", authorId: "author", executorId: "executor", needsInfoSince: null, pausedTotalMs: 0, deletedAt: null };
    expect(await readTaskAttachmentAccess(database, "task", "author")).toEqual({
      status: "denied", code: "INVALID_REQUEST_MARKER",
    });
  });

  it("propagates policy lookup failures without returning stored file metadata", async () => {
    const { database, task } = fixture();
    vi.mocked(getTaskReadWhere).mockRejectedValue(new Error("policy unavailable"));
    await expect(readTaskAttachmentAccess(database, "task", "author")).rejects.toThrow("policy unavailable");
    expect(task.findFirst).not.toHaveBeenCalled();
  });

  it("projects only actor-visible attachments for list/mutation responses and rechecks revocation", async () => {
    const { database, state } = fixture();
    state.attachments = [attachment, { ...attachment, url: attachmentFileUrl("task", "00000000-0000-4000-8000-000000000002"), name: "internal.txt", isInternal: true }];
    const expectedPublic = [attachment];
    const internal = state.attachments[1]!;
    const expectedInternal = [attachment, { url: internal.url, name: internal.name, size: internal.size, mime: internal.mime }];

    expect(await readVisibleTaskAttachments(database, { id: "author", globalRole: "USER" }, "board", state.attachments))
      .toEqual(expectedPublic);
    expect(await readVisibleTaskAttachments(database, { id: "member", globalRole: "USER" }, "board", state.attachments))
      .toEqual(expectedInternal);

    state.groupActive = false;
    expect(await readVisibleTaskAttachments(database, { id: "member", globalRole: "USER" }, "board", state.attachments))
      .toEqual(expectedPublic);
    expect(await readVisibleTaskAttachments(database, { id: "member", globalRole: "USER" }, "board", undefined))
      .toBeUndefined();
  });
});

describe("attachment URL membership", () => {
  it("only accepts the exact authenticated proxy path for the current task", () => {
    expect(attachmentBelongsToTask([attachment], "task", fileId)).toEqual(attachment);
    expect(attachmentBelongsToTask([attachment], "other-task", fileId)).toBeNull();
    for (const url of [
      `https://public.example/${fileId}`,
      `${attachment.url}?signature=old`,
      `/api/tasks/task/files/%30${fileId.slice(1)}`,
    ]) {
      expect(attachmentBelongsToTask([{ ...attachment, url }], "task", fileId)).toBeNull();
    }
  });
});
