import { describe, expect, it, vi } from "vitest";
import { readTaskRequestDecision } from "./task-request-guard";

type Database = Parameters<typeof readTaskRequestDecision>[0];
function database(value: unknown) {
  const findUnique = vi.fn(async () => value);
  return { findUnique, client: { taskRequest: { findUnique } } as unknown as Database };
}
describe("bounded injected TaskRequest read guard", () => {
  it("allows only an explicit absent row and uses the closed five-field transaction projection", async () => {
    const h = database(null); expect(await readTaskRequestDecision(h.client, "task")).toEqual({ allowed: true, mode: "legacy" });
    expect(h.findUnique).toHaveBeenCalledExactlyOnceWith({ where: { taskId: "task" }, select: { taskId: true, contractVersion: true, state: true, authorId: true, executorId: true } });
    expect(Object.keys(h.client)).toEqual(["taskRequest"]);
  });
  it.each([undefined, {}, { taskId: "other", contractVersion: 1, state: "DRAFT", authorId: "author", executorId: null }])("does not turn malformed query result %# into absence", async value => {
    expect(await readTaskRequestDecision(database(value).client, "task")).toEqual({ allowed: false, code: "INVALID_REQUEST_MARKER" });
  });
  it("refuses a marked row without returning its identity or contents", async () => {
    const result = await readTaskRequestDecision(database({ taskId: "task", contractVersion: 1, state: "DRAFT", authorId: "private-author", executorId: null }).client, "task");
    expect(result).toEqual({ allowed: false, code: "REQUEST_LIFECYCLE_NOT_ENABLED" }); expect(JSON.stringify(result)).not.toContain("private-author");
  });
  it("propagates database rejection unchanged", async () => {
    const h = database(null), failure = Error("synthetic lookup failure"); h.findUnique.mockRejectedValue(failure);
    await expect(readTaskRequestDecision(h.client, "task")).rejects.toBe(failure);
  });
  it.each([{}, { taskRequest: undefined }, { taskRequest: {} }])("fails closed on absent or malformed delegate %#", async client => {
    await expect(readTaskRequestDecision(client as unknown as Database, "task")).rejects.toBeInstanceOf(Error);
  });
});
