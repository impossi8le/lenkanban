import { describe, expect, it } from "vitest";
import { taskPrioritySchema } from "./validators";
import { getTaskPriorityPresentation, TASK_PRIORITY_OPTIONS } from "./task-priority";

describe("task priority display contract", () => {
  it("offers only the two agreed urgency levels while retaining legacy API values", () => {
    expect(TASK_PRIORITY_OPTIONS.map(option => option.value)).toEqual(["URGENT", "LOW"]);
    expect(TASK_PRIORITY_OPTIONS.map(option => option.label)).toEqual([
      "Срочно", "Не срочно",
    ]);
    for (const option of TASK_PRIORITY_OPTIONS) {
      expect(taskPrioritySchema.parse(option.value)).toBe(option.value);
      expect(getTaskPriorityPresentation(option.value).color).toBe(`priority-${option.value.toLowerCase()}`);
    }
  });

  it.each(["NEW_PRIORITY", "constructor", "toString", "", null, undefined, 3])(
    "shows an explicit neutral fallback for %s", value => {
      expect(getTaskPriorityPresentation(value)).toEqual({
        label: "Неизвестный приоритет",
        color: "border-border bg-muted text-muted-foreground",
        dot: "bg-muted-foreground",
      });
    },
  );

  it("normalizes display without changing the source DTO", () => {
    const task = { priority: " critical " };
    expect(getTaskPriorityPresentation(task.priority).label).toBe("Срочно");
    expect(task.priority).toBe(" critical ");
  });
});
