import { describe, expect, it } from "vitest";
import {
  ALTERNATE_TASK_DISPLAY_SORTS,
  isAlternateTaskDisplaySort,
} from "@/features/kanban/model/task-display-sort";
import { isTaskReorderEnabled } from "./use-kanban-dnd";

const noFilters = {
  statusFilter: null,
  priorityFilter: null,
  assigneeFilter: null,
  tagsFilter: null,
} as const;

/**
 * #36 acceptance: the policy for drag-and-drop while a sort is active is
 * explicit and shared. A derived (presentation-only) order can never produce a
 * persisted position, so positional drag and same-column menu moves are off.
 */
describe("position reorder policy under display sorting", () => {
  it.each(ALTERNATE_TASK_DISPLAY_SORTS)(
    "disables positional reorder for the %s sort",
    (sortBy) => {
      expect(isAlternateTaskDisplaySort(sortBy)).toBe(true);
      expect(isTaskReorderEnabled({ sortBy, ...noFilters })).toBe(false);
    },
  );

  it("enables positional reorder only for the persisted position order", () => {
    expect(isAlternateTaskDisplaySort("position")).toBe(false);
    expect(isTaskReorderEnabled({ sortBy: "position", ...noFilters })).toBe(true);
  });

  it("keeps unknown modes presentation-only without claiming reorder support", () => {
    for (const sortBy of ["", "unknown-mode", "POSITION"]) {
      expect(isAlternateTaskDisplaySort(sortBy)).toBe(false);
      expect(isTaskReorderEnabled({ sortBy, ...noFilters })).toBe(false);
    }
  });

  it("still disables reorder under filters while ordering by position", () => {
    expect(isTaskReorderEnabled({ sortBy: "position", ...noFilters, statusFilter: "TODO" })).toBe(false);
    expect(isTaskReorderEnabled({ sortBy: "position", ...noFilters, priorityFilter: "HIGH" })).toBe(false);
    expect(isTaskReorderEnabled({ sortBy: "position", ...noFilters, assigneeFilter: "user-1" })).toBe(false);
    expect(isTaskReorderEnabled({ sortBy: "position", ...noFilters, tagsFilter: ["tag-1"] })).toBe(false);
    expect(isTaskReorderEnabled({ sortBy: "position", ...noFilters, tagsFilter: ["ALL"] })).toBe(true);
  });

  it("never reports reorder enabled for a mode the sorter derives", () => {
    const modes = ["position", "unknown-mode", ...ALTERNATE_TASK_DISPLAY_SORTS];
    for (const sortBy of modes) {
      if (isTaskReorderEnabled({ sortBy, ...noFilters })) {
        expect(isAlternateTaskDisplaySort(sortBy)).toBe(false);
        expect(sortBy).toBe("position");
      }
    }
  });
});
