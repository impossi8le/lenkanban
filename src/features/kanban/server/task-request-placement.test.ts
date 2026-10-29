import { describe, expect, it, vi } from "vitest";
import { prepareLifecyclePlacement, type LifecyclePlacementContext } from "./task-request-placement";
import { formatRank, RANK_MAX } from "../rank/rank-service";

function fixture() {
  const map = { contractVersion: 1 as const, submittedColumnId: "new", inProgressColumnId: "work", needsInfoColumnId: "wait", completedColumnId: "resolved", closedColumnId: "closed" };
  const context: LifecyclePlacementContext = { map, columns: [{ id: "wait", projectId: "board", workflowKey: "COLUMN_wait" }], lockedTaskIds: new Set(["sibling"]) };
  const tx = { $queryRaw: vi.fn(), task: {
    findFirst: vi.fn(async () => ({ rank: formatRank(RANK_MAX), position: 10 })),
    findMany: vi.fn(async () => [{ id: "sibling" }]), update: vi.fn(async () => ({})),
  }, taskRequest: { findMany: vi.fn(async () => [] as object[]) } };
  return { tx, context };
}
describe("lifecycle placement rank maintenance", () => {
  it("checks the actual locked sibling write set before every temporary rank update", async () => {
    const f = fixture();
    f.tx.taskRequest.findMany.mockResolvedValue([{ taskId: "sibling", contractVersion: 1, state: "SUBMITTED", authorId: "author", executorId: null }]);
    await expect(prepareLifecyclePlacement(f.tx as never, f.context, { id: "moving", columnId: "source" }, "NEEDS_INFO")).rejects.toMatchObject({ code: "INVALID_LIFECYCLE_COLUMNS" });
    expect(f.tx.task.update).not.toHaveBeenCalled();
    expect(f.tx.taskRequest.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { taskId: { in: ["sibling"] } } }));
  });
  it("rejects an actual rank write set outside the held locks before touching siblings", async () => {
    const f = fixture(); f.context.lockedTaskIds.clear();
    await expect(prepareLifecyclePlacement(f.tx as never, f.context, { id: "moving", columnId: "source" }, "NEEDS_INFO")).rejects.toThrow("Unlocked lifecycle rank write set");
    expect(f.tx.task.update).not.toHaveBeenCalled();
  });
  it("reuses the rank engine and performs both maintenance phases only for legacy siblings", async () => {
    const f = fixture();
    const result = await prepareLifecyclePlacement(f.tx as never, f.context, { id: "moving", columnId: "source" }, "NEEDS_INFO");
    expect(result).toMatchObject({ columnId: "wait", status: "COLUMN_wait", position: 1034 });
    expect(result.rank).toMatch(/^0\|[0-9A-Z]{20}$/);
    expect(f.tx.task.update).toHaveBeenCalledTimes(2);
    expect(f.tx.task.update.mock.calls[0]).toEqual([{ where: { id: "sibling" }, data: { rank: expect.stringMatching(/^~/) } }]);
  });
});
