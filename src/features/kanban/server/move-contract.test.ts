import { describe, expect, it } from "vitest";
import {
  defaultWorkflowKey,
  derivedTaskStatus,
  MoveTaskRequestSchema,
  resolveWorkflowColumnFilter,
  workflowKeyForTemplateColumn,
} from "./move-contract";

describe("move task request contract", () => {
  const valid = {
    toColumnId: "cmmvsjc2b000uv09wieuhci5d",
    beforeTaskId: null,
    afterTaskId: "cmmuwxh220003v09lbyd19i80",
    operationId: "b1e62929-6741-4860-a6a3-5f90b82d5a11",
    expectedVersion: 4,
  };

  it("accepts the exact move command", () => {
    expect(MoveTaskRequestSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    [{ ...valid, operationId: "not-a-uuid" }, "operationId"],
    [{ ...valid, expectedVersion: -1 }, "expectedVersion"],
    [{ ...valid, toColumnId: "" }, "toColumnId"],
    [{ ...valid, extra: true }, "Unrecognized key"],
  ])("rejects malformed command %o", (input, message) => {
    expect(() => MoveTaskRequestSchema.parse(input)).toThrow(message);
  });

  it("assigns stable default workflow keys by original position", () => {
    expect(
      [0, 1, 2, 3, 4].map((position) =>
        defaultWorkflowKey(position, "column-5"),
      ),
    ).toEqual([
      "TODO",
      "IN_PROGRESS",
      "REVIEW",
      "DONE",
      "COLUMN_column-5",
    ]);
  });

  it("derives the legacy task status without depending on column position", () => {
    expect(derivedTaskStatus("REVIEW")).toBe("IN_REVIEW");
    expect(derivedTaskStatus("COLUMN_column-5")).toBe("COLUMN_column-5");
  });

  it("preserves explicitly stored reserved template workflow keys", () => {
    expect(
      workflowKeyForTemplateColumn({
        storedWorkflowKey: "REVIEW",
        name: "Moved review lane",
        columnId: "new-column",
      }),
    ).toBe("REVIEW");
  });

  it("regenerates custom template workflow identity for the new column", () => {
    expect(
      workflowKeyForTemplateColumn({
        storedWorkflowKey: "COLUMN_old-column",
        name: "Custom",
        columnId: "new-column",
      }),
    ).toBe("COLUMN_new-column");
  });

  it("does not reinterpret a stored custom workflow key from its display name", () => {
    expect(
      workflowKeyForTemplateColumn({
        storedWorkflowKey: "COLUMN_old-column",
        name: "DONE",
        columnId: "new-column",
      }),
    ).toBe("COLUMN_new-column");
  });

  it.each([
    ["TODO", "TODO"],
    ["IN_PROGRESS", "IN_PROGRESS"],
    ["IN_REVIEW", "REVIEW"],
    ["DONE", "DONE"],
    ["На проверке", "REVIEW"],
  ])(
    "maps legacy template name %s without consulting visual position",
    (name, workflowKey) => {
      expect(
        workflowKeyForTemplateColumn({
          name,
          columnId: "new-column",
        }),
      ).toBe(workflowKey);
    },
  );

  it("keeps an unknown legacy template column custom", () => {
    expect(
      workflowKeyForTemplateColumn({
        name: "First after reorder",
        columnId: "new-column",
      }),
    ).toBe("COLUMN_new-column");
  });

  it.each([
    ["TODO", "todo-column"],
    ["IN_REVIEW", "review-column"],
    ["review-column", "review-column"],
  ])(
    "resolves saved legacy workflow filter %s to column identity",
    (savedFilter, expectedColumnId) => {
      expect(
        resolveWorkflowColumnFilter(savedFilter, [
          { id: "todo-column", workflowKey: "TODO" },
          { id: "review-column", workflowKey: "REVIEW" },
        ]),
      ).toBe(expectedColumnId);
    },
  );
});
