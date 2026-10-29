import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RESERVED_WORKFLOW_KEYS,
  validateTemplate,
  validateTemplateSet,
  type ValidationIssue,
} from "./validate";

const templatesDir = path.dirname(fileURLToPath(import.meta.url));

const templateFiles = ["tech-support.json"] as const;

function readTemplate(file: string): unknown {
  return JSON.parse(readFileSync(path.join(templatesDir, file), "utf8"));
}

function fixture(): Record<string, unknown> {
  return structuredClone(readTemplate("tech-support.json")) as Record<string, unknown>;
}

function codes(issues: ValidationIssue[]): string[] {
  return issues.map((entry) => entry.code);
}

function expectCode(issues: ValidationIssue[], code: string): void {
  expect(codes(issues), `expected ${code} in ${JSON.stringify(codes(issues))}`).toContain(code);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

describe("board template files", () => {
  it("declares the support route and the common applicant format", () => {
    const data = fixture();
    expect(data.name).toBe("Техподдержка и ИТ");
    const columns = data.columns as Array<{ key: string; name: string; workflowKey: string | null; final: boolean }>;
    expect(columns.map(column => column.name)).toEqual(["Новые", "В работе", "Ждём сотрудника", "Решено", "Закрыто"]);
    expect(columns.filter(column => column.final)).toEqual([expect.objectContaining({ key: "closed", workflowKey: "DONE" })]);
    expect(data.descriptionHint).toMatch(/названии.*описании.*приложите/);
    expect(data).not.toHaveProperty("requiredFields");
    const transitions = data.transitions as Array<{ from: string; to: string }>;
    for (const [from, to] of [["new", "in-progress"], ["in-progress", "waiting"], ["waiting", "in-progress"], ["in-progress", "resolved"], ["resolved", "closed"]]) {
      expect(transitions).toContainEqual(expect.objectContaining({ from, to }));
    }
  });

  it("loads the single support JSON template in the directory", () => {
    const sources = templateFiles.map((file) => ({ source: file, data: readTemplate(file) }));
    expect(sources).toHaveLength(1);
    expect(readdirSync(templatesDir).filter((file) => file.endsWith(".json")).sort())
      .toEqual([...templateFiles].sort());
  });

  it("validates every template without issues", () => {
    const result = validateTemplateSet(
      templateFiles.map((file) => ({ source: file, data: readTemplate(file) })),
    );
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("declares exactly one final column per template", () => {
    const result = validateTemplateSet(
      templateFiles.map((file) => ({ source: file, data: readTemplate(file) })),
    );
    expect(result.templates.map((entry) => entry.key)).toEqual(["tech-support"]);
    const byKey = new Map(
      templateFiles.map((file) => [path.basename(file, ".json"), readTemplate(file)]),
    );
    for (const template of result.templates) {
      const raw = byKey.get(template.key) as { columns: Array<{ key: string; final: boolean }> };
      expect(raw.columns.filter((column) => column.final)).toHaveLength(1);
      expect(raw.columns[raw.columns.length - 1]?.key).toBe(template.finalColumnKey);
    }
  });

  it("never claims to be an active feature", () => {
    const result = validateTemplateSet(
      templateFiles.map((file) => ({ source: file, data: readTemplate(file) })),
    );
    for (const template of result.templates) {
      expect(["declared-not-active", "pilot-candidate"]).toContain(template.activation);
    }
  });

  it("does not mutate frozen input", () => {
    const frozen = deepFreeze(fixture());
    const before = JSON.stringify(frozen);
    expect(() => validateTemplate("frozen.json", frozen)).not.toThrow();
    expect(JSON.stringify(frozen)).toBe(before);
  });
});

describe("column validation", () => {
  it("rejects duplicate column keys", () => {
    const data = fixture();
    const columns = data.columns as Array<Record<string, unknown>>;
    columns[1].key = "new";
    expectCode(validateTemplate("case.json", data), "column.key.duplicate");
  });

  it("rejects empty column names", () => {
    const data = fixture();
    const columns = data.columns as Array<Record<string, unknown>>;
    columns[1].name = "   ";
    expectCode(validateTemplate("case.json", data), "column.name.empty");
  });

  it("rejects two final columns", () => {
    const data = fixture();
    const columns = data.columns as Array<Record<string, unknown>>;
    columns[3].final = true;
    expectCode(validateTemplate("case.json", data), "columns.final.multiple");
  });

  it("rejects a template without a final column", () => {
    const data = fixture();
    for (const column of data.columns as Array<Record<string, unknown>>) column.final = false;
    expectCode(validateTemplate("case.json", data), "columns.final.missing");
  });

  it("requires the final column to be last", () => {
    const data = fixture();
    const columns = data.columns as Array<Record<string, unknown>>;
    columns[4].final = false;
    columns[2].final = true;
    expectCode(validateTemplate("case.json", data), "columns.final.position");
  });

  it("requires positions to follow array order", () => {
    const data = fixture();
    const columns = data.columns as Array<Record<string, unknown>>;
    columns[0].position = 1;
    columns[1].position = 0;
    expectCode(validateTemplate("case.json", data), "column.position.order");
  });

  it("rejects unknown reserved workflow keys", () => {
    const data = fixture();
    const columns = data.columns as Array<Record<string, unknown>>;
    columns[0].workflowKey = "ARCHIVED";
    expectCode(validateTemplate("case.json", data), "column.workflow_key.reserved");
    expect(RESERVED_WORKFLOW_KEYS).toEqual(["TODO", "IN_PROGRESS", "REVIEW", "DONE"]);
  });

  it("rejects duplicate reserved workflow keys", () => {
    const data = fixture();
    const columns = data.columns as Array<Record<string, unknown>>;
    columns[1].workflowKey = "TODO";
    expectCode(validateTemplate("case.json", data), "column.workflow_key.duplicate");
  });
});

describe("transition validation", () => {
  it("rejects transitions to unknown columns", () => {
    const data = fixture();
    const transitions = data.transitions as Array<Record<string, unknown>>;
    transitions[0].to = "ghost";
    expectCode(validateTemplate("case.json", data), "transition.to.unknown");
  });

  it("rejects self transitions", () => {
    const data = fixture();
    const transitions = data.transitions as Array<Record<string, unknown>>;
    transitions[0].to = transitions[0].from;
    expectCode(validateTemplate("case.json", data), "transition.self");
  });

  it("rejects duplicate transitions", () => {
    const data = fixture();
    const transitions = data.transitions as Array<Record<string, unknown>>;
    transitions.push({ ...transitions[0] });
    expectCode(validateTemplate("case.json", data), "transition.duplicate");
  });

  it("rejects board/project targeting fields", () => {
    const data = fixture();
    const transitions = data.transitions as Array<Record<string, unknown>>;
    transitions[0].targetBoard = "legal";
    expectCode(validateTemplate("case.json", data), "transition.cross_board_field");
  });

  it("rejects qualified cross-board references", () => {
    const data = fixture();
    const transitions = data.transitions as Array<Record<string, unknown>>;
    transitions[0].to = "legal:closed";
    const issues = validateTemplate("case.json", data);
    expectCode(issues, "transition.cross_board_reference");
    expect(codes(issues)).not.toContain("transition.to.unknown");
  });

  it("rejects allowing cross-board transfer", () => {
    const data = fixture();
    (data.crossBoardTransfer as Record<string, unknown>).allowed = true;
    expectCode(validateTemplate("case.json", data), "cross_board.allowed");
  });

  it("rejects transitions without actor or action", () => {
    const data = fixture();
    const transitions = data.transitions as Array<Record<string, unknown>>;
    transitions[0].actor = "";
    transitions[1].action = "";
    const issues = validateTemplate("case.json", data);
    expectCode(issues, "transition.actor.empty");
    expectCode(issues, "transition.action.empty");
  });
});

describe("declaration-only guarantees", () => {
  it("rejects an active activation state", () => {
    const data = fixture();
    data.activation = "active";
    expectCode(validateTemplate("case.json", data), "template.activation.not_allowed");
  });

  it("rejects visibility that claims enforcement", () => {
    const data = fixture();
    (data.visibility as Record<string, unknown>).enforced = true;
    expectCode(validateTemplate("case.json", data), "visibility.claims_enforcement");
  });

  it("rejects invented numeric SLA targets", () => {
    const data = fixture();
    const hints = (data.sla as Record<string, unknown>).hints as Array<Record<string, unknown>>;
    hints[0].targetMinutes = 60;
    expectCode(validateTemplate("case.json", data), "sla.hint.numeric_target");
  });

  it("requires open questions for the process owner", () => {
    const data = fixture();
    data.openQuestions = [];
    expectCode(validateTemplate("case.json", data), "open_questions.missing");
  });

  it("requires a description hint", () => {
    const data = fixture();
    data.descriptionHint = "";
    expectCode(validateTemplate("case.json", data), "template.hint.empty");
  });
});

describe("set-level validation", () => {
  it("rejects duplicate template keys across files", () => {
    const result = validateTemplateSet([
      { source: "a.json", data: fixture() },
      { source: "b.json", data: fixture() },
    ]);
    expectCode(result.issues, "template.key.duplicate");
    expect(result.ok).toBe(false);
  });

  it("rejects an empty template set", () => {
    expectCode(validateTemplateSet([]).issues, "templates.empty");
  });

  it("rejects extra states that collide with a column key", () => {
    const data = fixture();
    (data.extraStates as Array<Record<string, unknown>>).push({
      key: "new",
      name: "Дубль",
      final: false,
    });
    expectCode(validateTemplate("case.json", data), "extra_state.key.collision");
  });

  it("rejects a non-object template", () => {
    expectCode(validateTemplate("case.json", []), "template.not_object");
  });
});
