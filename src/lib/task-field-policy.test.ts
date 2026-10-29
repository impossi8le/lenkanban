import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { requireTaskDeadlineExecutor } from "./task-field-policy";

describe("deadline executor authority under the caller's Task lock", () => {
  it.each([[], [{ userId: "other" }], [{ userId: "actor" }, { userId: "other" }]].map(assignees => ({ assignees })))("denies unassigned, other and ambiguous assignments: %j", async ({ assignees }) => {
    const findMany = vi.fn().mockResolvedValue(assignees);
    await expect(requireTaskDeadlineExecutor({ taskAssignee: { findMany } } as unknown as Prisma.TransactionClient, "actor", "task"))
      .rejects.toMatchObject({ name: "NotFoundError" });
    expect(findMany).toHaveBeenCalledWith({ where: { taskId: "task" }, select: { userId: true }, take: 2 });
  });
  it("allows only the current sole assignee", async () => {
    const tx = { taskAssignee: { findMany: vi.fn().mockResolvedValue([{ userId: "actor" }]) } };
    await expect(requireTaskDeadlineExecutor(tx as unknown as Prisma.TransactionClient, "actor", "task")).resolves.toBeUndefined();
  });
});
