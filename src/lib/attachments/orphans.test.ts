import { describe, expect, it, vi } from "vitest";
import { ORPHAN_GRACE_MS, reconcileTaskOrphans, iterateOrphanTaskBatches } from "./orphans";
import { AttachmentStorageError } from "./storage";

const taskId = "task";
const live = "0a6e3b9e-3dcb-402e-891a-d1074b75d40f";
const stale = "1b6e3b9e-3dcb-402e-891a-d1074b75d40f";
const fresh = "2c6e3b9e-3dcb-402e-891a-d1074b75d40f";
const unknownAge = "3d6e3b9e-3dcb-402e-891a-d1074b75d40f";
const now = new Date("2026-10-21T12:00:00.000Z");
const old = new Date(now.getTime() - ORPHAN_GRACE_MS - 1000);

function fixture() {
  const store = {
    put: vi.fn(),
    get: vi.fn(),
    deleteOwned: vi.fn(async () => undefined),
    list: vi.fn(async () => [
      { fileId: live, lastModified: old },
      { fileId: stale, lastModified: old },
      { fileId: fresh, lastModified: new Date(now.getTime() - 1000) },
      { fileId: unknownAge, lastModified: null },
    ]),
  };
  return { store };
}

const attachments = [{ url: `/api/tasks/${taskId}/files/${live}`, name: "a.pdf", size: 1, mime: "application/pdf" }];

describe("orphan reconciliation", () => {
  it("scans beyond 25 tasks by immutable ID, including soft-deleted tasks", async () => {
    const rows = Array.from({ length: 61 }, (_, index) => ({
      id: `task-${String(index).padStart(3, "0")}`,
      attachments: index === 40 ? attachments : [],
      deletedAt: index === 40 ? old : null,
    }));
    const findMany = vi.fn(async (query: { where: { id?: { gt: string } }; take: number }) =>
      rows.filter(row => !query.where.id || row.id > query.where.id.gt).slice(0, query.take));
    const visited = [];
    for await (const batch of iterateOrphanTaskBatches({ task: { findMany } })) {
      expect(batch.length).toBeLessThanOrEqual(25);
      visited.push(...batch);
    }
    expect(visited).toEqual(rows);
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(findMany.mock.calls[1][0]).toEqual({
      where: { id: { gt: "task-024" } }, orderBy: { id: "asc" }, take: 25,
      select: { id: true, attachments: true },
    });
  });
  it("finishes an empty inventory and exact page boundary", async () => {
    const findMany = vi.fn().mockResolvedValueOnce([{ id: "a", attachments: [] }]).mockResolvedValueOnce([]);
    const visited = [];
    for await (const batch of iterateOrphanTaskBatches({ task: { findMany } }, 1)) visited.push(...batch);
    expect(visited).toEqual([{ id: "a", attachments: [] }]);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
  it("rejects invalid page sizes without querying", async () => {
    const findMany = vi.fn();
    for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(iterateOrphanTaskBatches({ task: { findMany } }, size).next()).rejects.toBeInstanceOf(AttachmentStorageError);
    }
    expect(findMany).not.toHaveBeenCalled();
  });
  it("continues when the preceding page's last task is hard-deleted", async () => {
    let rows = [{ id: "a", attachments: [] }, { id: "b", attachments: [] }];
    const findMany = vi.fn(async (query: { where: { id?: { gt: string } }; take: number }) =>
      rows.filter(row => !query.where.id || row.id > query.where.id.gt).slice(0, query.take));
    const iterator = iterateOrphanTaskBatches({ task: { findMany } }, 1);
    expect((await iterator.next()).value).toEqual([rows[0]]);
    rows = rows.slice(1);
    expect((await iterator.next()).value).toEqual(rows);
    expect((await iterator.next()).done).toBe(true);
  });
  it("deletes only unreferenced objects older than the grace period", async () => {
    const { store } = fixture();
    const result = await reconcileTaskOrphans(store, { taskId, attachments, now });
    expect(result.deleted).toEqual([stale]);
    expect(result.kept).toBe(3);
    expect(result.failed).toEqual([]);
    expect(store.deleteOwned).toHaveBeenCalledTimes(1);
    expect(store.deleteOwned).toHaveBeenCalledWith(taskId, stale);
  });

  it("never deletes a referenced object even when it is old", async () => {
    const { store } = fixture();
    await reconcileTaskOrphans(store, { taskId, attachments, now, graceMs: 0 });
    expect(store.deleteOwned).not.toHaveBeenCalledWith(taskId, live);
  });

  it("keeps everything when the metadata array still references it", async () => {
    const { store } = fixture();
    store.list = vi.fn(async () => [{ fileId: live, lastModified: old }]);
    const result = await reconcileTaskOrphans(store, { taskId, attachments, now });
    expect(result).toEqual({ deleted: [], kept: 1, failed: [] });
    expect(store.deleteOwned).not.toHaveBeenCalled();
  });

  it("reports per-object deletion failures without aborting the sweep", async () => {
    const { store } = fixture();
    store.list = vi.fn(async () => [
      { fileId: stale, lastModified: old },
      { fileId: "4e6e3b9e-3dcb-402e-891a-d1074b75d40f", lastModified: old },
    ]);
    store.deleteOwned = vi.fn()
      .mockRejectedValueOnce(new AttachmentStorageError("UNAVAILABLE"))
      .mockResolvedValueOnce(undefined);
    const result = await reconcileTaskOrphans(store, { taskId, attachments, now });
    expect(result.deleted).toEqual(["4e6e3b9e-3dcb-402e-891a-d1074b75d40f"]);
    expect(result.failed).toEqual([stale]);
  });

  it("aborts without deleting anything when the inventory fails", async () => {
    const { store } = fixture();
    store.list = vi.fn(async () => { throw new AttachmentStorageError("UNAVAILABLE"); });
    await expect(reconcileTaskOrphans(store, { taskId, attachments, now }))
      .rejects.toBeInstanceOf(AttachmentStorageError);
    expect(store.deleteOwned).not.toHaveBeenCalled();
  });

  it("rejects an invalid clock, grace period or task ID before listing", async () => {
    const { store } = fixture();
    await expect(reconcileTaskOrphans(store, { taskId, attachments, now: new Date("nope") }))
      .rejects.toBeInstanceOf(AttachmentStorageError);
    await expect(reconcileTaskOrphans(store, { taskId, attachments, now, graceMs: -1 }))
      .rejects.toBeInstanceOf(AttachmentStorageError);
    await expect(reconcileTaskOrphans(store, { taskId: "../task", attachments, now }))
      .rejects.toBeInstanceOf(AttachmentStorageError);
    expect(store.list).not.toHaveBeenCalled();
  });

  it("does not treat a legacy external URL as an owned reference", async () => {
    const { store } = fixture();
    store.list = vi.fn(async () => [{ fileId: stale, lastModified: old }]);
    const result = await reconcileTaskOrphans(store, {
      taskId, now,
      attachments: [{ url: "https://example.invalid/x.pdf", name: "x.pdf", size: 1, mime: "application/pdf" }],
    });
    expect(result.deleted).toEqual([stale]);
  });
});
