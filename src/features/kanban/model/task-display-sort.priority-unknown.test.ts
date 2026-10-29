import { expect, it } from "vitest";
import { sortTasksForDisplay } from "./task-display-sort";

it("sorts arbitrary unknown priorities after all known values, including prototype-like names", () => {
  const priorities = ["constructor", "toString", "FUTURE", "LOW", "MEDIUM", "HIGH", "URGENT", "CRITICAL"];
  const tasks = priorities.map((priority, index) => ({ id: String(index), priority, position: 0 }));
  const sorted = sortTasksForDisplay(tasks, "priority-desc");
  expect(sorted.map(task => task.priority)).toEqual([
    "CRITICAL", "URGENT", "HIGH", "MEDIUM", "LOW", "constructor", "toString", "FUTURE",
  ]);
  expect(tasks.map(task => task.priority)).toEqual(priorities);
});
