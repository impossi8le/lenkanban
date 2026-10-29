import { describe, expect, it } from "vitest";
import {
  normalizeTaskSearch,
  taskSearchPredicate,
  tokenizeTaskSearch,
  TASK_SEARCH_FIELDS,
  TASK_SEARCH_IDENTIFIER_MIN_LENGTH,
  TASK_SEARCH_QUERY_LIMIT,
  TASK_SEARCH_TOKEN_LIMIT,
} from "./task-search";

function matches(row: unknown, predicate: unknown): boolean {
  if (predicate === null || typeof predicate !== "object") return row === predicate;
  return Object.entries(predicate).every(([key,value]) => {
    if (key === "OR") return (value as unknown[]).some(branch => matches(row, branch));
    if (key === "AND") return (value as unknown[]).every(branch => matches(row, branch));
    if (key === "is") return value === null ? row === null : row !== null && row !== undefined && matches(row,value);
    if (key === "some") return Array.isArray(row) && row.some(item => matches(item,value));
    if (key === "contains") return typeof row === "string" && row.toLocaleLowerCase().includes(String(value).toLocaleLowerCase());
    if (key === "mode") return true;
    return Boolean(row && typeof row === "object") && matches((row as Record<string,unknown>)[key],value);
  });
}

const base = {
  title: "Заявка",
  description: "Подробности",
  request: { contractVersion: 1, author: { name: "Анна" }, executor: { name: "Борис" } },
  createdBy: { name: "Старый автор" },
  assignees: [{ user: { name: "Старый исполнитель" } }],
  messages: [{ content: "Скрытая переписка" }],
};

describe("shared request search fields", () => {
  it("trims and bounds the existing search term", () => {
    expect(normalizeTaskSearch("  Анна  ")).toBe("Анна");
    expect(normalizeTaskSearch(" ")).toBe("");
    expect(normalizeTaskSearch(null)).toBe("");
    expect(normalizeTaskSearch("x".repeat(500))).toHaveLength(TASK_SEARCH_QUERY_LIMIT);
  });

  it("keeps one ordered field list for every request search", () => {
    expect(TASK_SEARCH_FIELDS).toEqual([
      "title",
      "description",
      "requestAuthor",
      "requestExecutor",
      "legacyCreator",
      "legacyAssignees",
      "identifier",
      "project",
      "tags",
    ]);
  });

  it("splits words, ignores punctuation and duplicates, and stays bounded", () => {
    expect(tokenizeTaskSearch("  «Пропуск»,  АННА! пропуск  ")).toEqual(["Пропуск", "АННА"]);
    expect(tokenizeTaskSearch(" , ")).toEqual([]);
    const bounded = Array.from({ length: TASK_SEARCH_TOKEN_LIMIT + 4 }, (_, index) => `word${index}`).join(" ");
    expect(tokenizeTaskSearch(bounded)).toHaveLength(TASK_SEARCH_TOKEN_LIMIT);
  });

  it.each(["заявка", "подробности", "АННА", "борис"])(
    "matches actual canonical title/description/author/executor: %s",
    query => { expect(matches(base, taskSearchPredicate(query))).toBe(true); },
  );

  it("matches separate words in any order across fields but requires every word", () => {
    const row = {
      ...base,
      title: "Повторный пропуск",
      description: "Клиент Анна Петрова, заказ 5305316",
      request: { contractVersion: 1, author: { name: "Анна Петрова" }, executor: { name: "Борис" } },
    };
    for (const query of [
      "пропуск анна",
      "Анна ПРОПУСК",
      "петрова 5305316",
      "борис пропуск",
      "«Пропуск», Анна!",
    ]) {
      expect(matches(row, taskSearchPredicate(query))).toBe(true);
    }
    expect(matches(row, taskSearchPredicate("пропуск неизвестно"))).toBe(false);
    expect(matches(row, taskSearchPredicate("анна борис заявка"))).toBe(false);
  });

  it("never uses stale legacy people on a canonical request or internal message content", () => {
    for (const query of ["Старый автор", "Старый исполнитель", "Скрытая переписка"]) {
      expect(matches(base, taskSearchPredicate(query))).toBe(false);
    }
  });

  it("uses legacy creator and assignees only for a truly absent request", () => {
    for (const query of ["Старый автор", "Старый исполнитель", "автор исполнитель"]) {
      expect(matches({ ...base, request: null }, taskSearchPredicate(query))).toBe(true);
    }
    expect(matches(
      { ...base, request: { contractVersion: 1, author: { name: "Анна" }, executor: null } },
      taskSearchPredicate("Старый исполнитель"),
    )).toBe(false);
  });

  it("finds existing claim order, phone, address and client data stored in the description", () => {
    const claim = {
      ...base,
      description: [
        "Сведения об обращении (v1)",
        "Направление: claim",
        "Категория: Претензия",
        "Номер заказа: 5305316",
        "Телефон клиента: +7 (921) 123-45-67",
        "Клиент: ООО Ромашка",
        "Адрес: ул. Ленина, 5",
        "Конец сведений",
        "",
        "Просит заменить пропуск",
      ].join("\n"),
    };
    for (const query of [
      "5305316",
      "заказ 5305316",
      "921 123 45 67",
      "ромашка ленина",
      "претензия пропуск",
    ]) {
      expect(matches(claim, taskSearchPredicate(query))).toBe(true);
    }
  });

  it("returns no matches for a query without words instead of widening the list", () => {
    expect(taskSearchPredicate(" , ")).toEqual({ OR: [] });
    expect(matches(base, taskSearchPredicate(" , "))).toBe(false);
  });
  it("combines safe board, tag and identifier terms with request content", () => {
    const row = { ...base, id: "request123", project: { name: "Техподдержка" }, tags: [{ tag: { name: "Принтер" } }] };
    expect(matches(row, taskSearchPredicate("Анна принтер техподдержка request123"))).toBe(true);
  });

  it("does not let a one-digit word match unrelated identifier characters", () => {
    const row = { ...base, id: "clx4unrelated" };
    const predicate = taskSearchPredicate("Анна 4") as {
      AND: Array<{ OR: Array<Record<string, unknown>> }>;
    };
    expect(predicate.AND[1].OR).toHaveLength(TASK_SEARCH_FIELDS.length - 1);
    expect(predicate.AND[1].OR.some(branch => "id" in branch)).toBe(false);
    expect(matches(row, taskSearchPredicate("Анна 4"))).toBe(false);
    expect(matches(row, taskSearchPredicate("4 Анна"))).toBe(false);
    // The same word still searches real content and people.
    expect(matches({ ...row, description: "Подробности 4" }, taskSearchPredicate("Анна 4"))).toBe(true);
    expect(matches(row, taskSearchPredicate("Анна заявка"))).toBe(true);
  });

  it("finds the numbered executor without matching a different employee's random ID", () => {
    const unrelated = { ...base, id: "clx4unrelated", request: { contractVersion: 1,
      author: { name: "Сотрудник поддержки 2" }, executor: null } };
    const assigned = { ...base, id: "clxassigned", request: { contractVersion: 1,
      author: { name: "Пользователь 1" }, executor: { name: "Сотрудник поддержки 4" } } };
    expect(matches(unrelated, taskSearchPredicate("Сотрудник поддержки 4"))).toBe(false);
    expect(matches(assigned, taskSearchPredicate("Сотрудник поддержки 4"))).toBe(true);
    expect(matches(assigned, taskSearchPredicate("4 поддержки сотрудник"))).toBe(true);
  });

  it("enables identifier matching only from four Unicode code points", () => {
    const row = { ...base, id: "request1234" };
    expect(TASK_SEARCH_IDENTIFIER_MIN_LENGTH).toBe(4);
    expect(matches(row, taskSearchPredicate("123"))).toBe(false);
    expect(matches(row, taskSearchPredicate("1234"))).toBe(true);
    expect(matches(row, taskSearchPredicate("Анн"))).toBe(true);
  });

  it("keeps every public field branch for a pure short numeric query", () => {
    const row = { ...base, description: "Номер заказа: 530" };
    const predicate = taskSearchPredicate("530") as { OR: Array<Record<string, unknown>> };
    expect(predicate.OR).toHaveLength(TASK_SEARCH_FIELDS.length - 1);
    expect(predicate.OR.some(branch => "id" in branch)).toBe(false);
    expect(matches(row, taskSearchPredicate("530"))).toBe(true);
  });

  it("keeps word order semantics with per-word identifier eligibility", () => {
    const row = { ...base, id: "clx4unrelated", title: "Повторный пропуск" };
    for (const query of ["Анна 4", "4 Анна", "пропуск 4", "4 пропуск"]) {
      expect(matches(row, taskSearchPredicate(query))).toBe(false);
    }
    const withContent = { ...row, description: "Подробности 4" };
    for (const query of ["Анна 4", "4 Анна", "пропуск 4", "4 пропуск"]) {
      expect(matches(withContent, taskSearchPredicate(query))).toBe(true);
    }
  });

  it("keeps canonical and legacy people separate for short terms", () => {
    expect(matches(base, taskSearchPredicate("тар"))).toBe(false);
    expect(matches(base, taskSearchPredicate("Анн"))).toBe(true);
    expect(matches({ ...base, request: null }, taskSearchPredicate("тар"))).toBe(true);
  });
});
