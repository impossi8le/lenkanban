import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("./logger", () => ({
  dbLogger: { error: vi.fn() },
}));

import { getActivityDescription } from "./activity-logger";
import { getActivityDescription as pureDescription } from "./activity-description";

it("preserves the server compatibility export as the exact pure formatter", () => {
  expect(getActivityDescription).toBe(pureDescription);
});

describe("move activity description", () => {
  it("uses readable column names and localized statuses without database IDs", () => {
    const description = getActivityDescription({
      action: "moved",
      oldValue: {
        columnId: "cm-source-database-id",
        columnName: "К выполнению",
        status: "TODO",
      },
      newValue: {
        columnId: "cm-destination-database-id",
        columnName: "В работе",
        status: "IN_PROGRESS",
      },
      user: { name: "Павел", email: "pavel@example.test" },
    });

    expect(description).toBe(
      "Павел переместил задачу из колонки «К выполнению» в «В работе» " +
        "(статус: «К выполнению» → «В работе»)",
    );
    expect(description).not.toContain("cm-source-database-id");
    expect(description).not.toContain("cm-destination-database-id");
  });

  it("falls back to localized status context when column names are absent", () => {
    expect(
      getActivityDescription({
        action: "moved",
        oldValue: {
          columnId: "cm-source-database-id",
          status: "IN_REVIEW",
        },
        newValue: {
          columnId: "cm-destination-database-id",
          status: "DONE",
        },
        user: { name: null, email: "user@example.test" },
      }),
    ).toBe(
      "user@example.test переместил задачу " +
        "(статус: «На проверке» → «Готово»)",
    );
  });
});

describe("checklist activity descriptions", () => {
  it.each([
    ["checklist_item_added", "Павел добавил пункт чек-листа «Проверить отчёт»"],
    ["checklist_item_completed", "Павел выполнил пункт чек-листа «Проверить отчёт»"],
    ["checklist_item_reopened", "Павел вернул в работу пункт чек-листа «Проверить отчёт»"],
    ["checklist_item_updated", "Павел изменил пункт чек-листа «Проверить отчёт»"],
    ["checklist_item_deleted", "Павел удалил пункт чек-листа «Проверить отчёт»"],
  ])("renders %s with readable item text", (action, expected) => {
    expect(getActivityDescription({
      action, oldValue: { text: "Проверить отчёт" }, newValue: { text: "Проверить отчёт" },
      user: { name: "Павел", email: "pavel@example.test" },
    })).toBe(expected);
  });
});

describe("localized activity values", () => {
  const user = { name: "Павел", email: "pavel@example.test" };
  it("formats priorities as human-readable Russian labels", () => {
    const description = getActivityDescription({ action: "priority_changed", oldValue: { priority: "MEDIUM" }, newValue: { priority: "HIGH" }, user });
    expect(description).toContain("Средний");
    expect(description).toContain("Высокий");
    expect(description).not.toContain("HIGH");
  });
  it("formats an ISO deadline as a Russian date", () => {
    const description = getActivityDescription({ action: "deadline_set", oldValue: null, newValue: { deadline: "2026-10-01T12:00:00.000Z" }, user });
    expect(description).toContain("1 октября 2026");
    expect(description).not.toContain("T12:");
  });
  it.each([undefined, null, "invalid"])("handles an absent or invalid deadline without exposing invalid data", deadline => {
    const description = getActivityDescription({ action: "deadline_set", oldValue: null, newValue: { deadline }, user });
    expect(description).toContain("не указан");
    expect(description).not.toContain("Invalid");
    expect(description).not.toContain("undefined");
  });
});

describe("watcher history labels", () => {
  it.each([["watcher_added", "добавил"], ["watcher_removed", "убрал"]])("renders %s without target details", (action, verb) => {
    expect(getActivityDescription({ action, oldValue: null, newValue: null, user: { name: "Тест", email: "synthetic@example.invalid" } })).toBe(`Тест ${verb} наблюдателя`);
  });
});
