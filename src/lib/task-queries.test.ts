import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("./prisma", () => ({ prisma: { task: { findUnique: mocks.findUnique } } }));
import { loadTaskWithRelations } from "./task-queries";

beforeEach(() => mocks.findUnique.mockReset());
describe("safe realtime request presentation", () => {
  it.each([{ ids: [] as string[] }, { ids: ["selected"] }])("retains audience marker and actual people without recipient IDs: %j", async ({ ids }) => {
    mocks.findUnique.mockResolvedValue({ id: "task", request: { state: "IN_PROGRESS", executorId: "selected", audienceUserIds: ids,
      author: { id: "author", name: "Author", email: "not-for-projection" },
      executor: { id: "selected", name: "Current executor", email: "not-for-projection" } } });
    const task = await loadTaskWithRelations("task");
    expect(task?.request).toEqual({ state: "IN_PROGRESS", executorId: "selected", beznalPhase: null, isPersonal: ids.length > 0,
      author: { id: "author", name: "Author" }, executor: { id: "selected", name: "Current executor" } });
    expect(JSON.stringify(task)).not.toContain("audienceUserIds");
    expect(JSON.stringify(task)).not.toContain("not-for-projection");
  });
  it("preserves a legacy task with no canonical request", async () => {
    mocks.findUnique.mockResolvedValue({ id: "legacy", request: null });
    expect(await loadTaskWithRelations("legacy")).toEqual({ id: "legacy", request: null, descriptionEditedAt: null });
  });
  it("returns null for an unavailable task", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect(await loadTaskWithRelations("missing")).toBeNull();
  });
});


it("projects the description timestamp without exposing Activity content to realtime", async () => {
  const editedAt = new Date("2026-10-27T09:00:00Z");
  mocks.findUnique.mockResolvedValue({ id: "task", request: null, updatedAt: new Date("2026-10-27T11:00:00Z"),
    activities: [{ createdAt: editedAt, userId: "private-actor", oldValue: { description: "private-old-text" }, newValue: { description: "private-new-text" } }] });
  const task = await loadTaskWithRelations("task");
  expect(task?.descriptionEditedAt).toBe(editedAt.toISOString());
  expect(task).not.toHaveProperty("activities");
  expect(JSON.stringify(task)).not.toMatch(/private-actor|private-old-text|private-new-text/);
});
