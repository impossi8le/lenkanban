import { describe, expect, it } from "vitest";
import { z } from "zod";
import { inputs, jsonSchema, outputs } from "./schemas";
import { defaultWorkflowKey, derivedTaskStatus } from "@/features/kanban/server/move-contract";
import { toTaskDetailDTO } from "@/lib/task-detail-dto";
import { taskPrioritySchema } from "@/lib/validators";

const time = new Date("2026-10-23T00:00:00Z");
const operationId = "8c9f5278-284b-4c10-9c20-f544ed080b9a";

function property(schema: Record<string, unknown>, key: string) {
  return (schema.properties as Record<string, Record<string, unknown>>)[key];
}

function task(status: string, priority: string) {
  return JSON.parse(JSON.stringify(toTaskDetailDTO({
    id: "task",
    title: "Synthetic",
    description: null,
    status,
    priority,
    position: 1,
    version: 0,
    projectId: "project",
    columnId: "column",
    createdById: "actor",
    deadline: null,
    createdAt: time,
    updatedAt: time,
    attachments: [],
    assignees: [],
    tags: [],
    checklistItems: [],
  } as never)));
}

const columnStatus = () => derivedTaskStatus(defaultWorkflowKey(4, "actual-column"));

describe("canonical DTO schema compatibility", () => {
  it("accepts canonical constructor custom status in detail, list, board and move", () => {
    const status = columnStatus();
    const dto = task(status, "MEDIUM");

    expect(outputs.get_task.safeParse(dto).success).toBe(true);
    expect(outputs.list_tasks.safeParse({
      items: [{ ...dto, assigneeIds: [] }],
      page: 1,
      limit: 50,
      hasMore: false,
    }).success).toBe(true);
    expect(outputs.get_board.safeParse({
      board: {
        id: "project",
        name: "Synthetic",
        description: null,
        createdAt: time.toISOString(),
        updatedAt: time.toISOString(),
        taskCount: 1,
        memberCount: 1,
      },
      columns: [{
        id: "column",
        name: "Synthetic",
        color: "#112233",
        position: 4,
        workflowKey: status,
        status,
      }],
    }).success).toBe(true);
    expect(outputs.move_task.safeParse({
      operationId,
      boardRevision: 1,
      task: { id: "task", columnId: "column", version: 1, status },
    }).success).toBe(true);
  });

  it("matches all five canonical priority inputs and outputs", () => {
    for (const priority of taskPrioritySchema.options) {
      expect(inputs.create_task.safeParse({
        projectId: "project", title: "Synthetic", priority, operationId,
      }).success).toBe(true);
      expect(inputs.update_task.safeParse({
        taskId: "task", operationId, expectedVersion: 0, changes: { priority },
      }).success).toBe(true);
      expect(outputs.get_task.safeParse(task("TODO", priority)).success).toBe(true);
    }
    expect(property(jsonSchema(inputs.create_task), "priority").enum)
      .toEqual(taskPrioritySchema.options);
  });

  it("keeps custom filter via columnId and rejects custom status input", () => {
    expect(inputs.list_tasks.safeParse({
      projectId: "project", status: columnStatus(),
    }).success).toBe(false);
    expect(inputs.list_tasks.safeParse({
      projectId: "project", columnId: "actual-column",
    }).success).toBe(true);
    expect(inputs.list_tasks.parse({ projectId: "project" }))
      .toMatchObject({ page: 1, limit: 50 });
  });

  it("bounds generated output prefix without inventing an id charset", () => {
    const field = outputs.get_task.shape.status;
    for (const suffix of ["a", "id/with space", "Unicode-ю", "line\nbreak", "a".repeat(128)]) {
      expect(field.safeParse(derivedTaskStatus(defaultWorkflowKey(4, suffix))).success).toBe(true);
    }
    for (const bad of ["", "CUSTOM", "REVIEW", "CLOSED", "COLUMN_", `COLUMN_${"a".repeat(129)}`, "RANDOM"]) {
      expect(field.safeParse(bad).success).toBe(false);
    }
    for (const key of ["TODO", "IN_PROGRESS", "REVIEW", "DONE"]) {
      expect(field.safeParse(derivedTaskStatus(key)).success).toBe(true);
    }
  });

  it("advertises output union and exact regex bounds", () => {
    const schema = property(jsonSchema(outputs.get_task), "status");
    const options = schema.anyOf as Record<string, unknown>[];
    expect(options[0].enum).toEqual(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]);
    expect(options[1]).toMatchObject({
      type: "string", minLength: 8, maxLength: 135, pattern: "^COLUMN_[\\s\\S]+$",
    });

    const expression = new RegExp(String(options[1].pattern));
    const advertisedAccepts = (input: string) =>
      (options[0].enum as string[]).includes(input) || (
        input.length >= Number(options[1].minLength) &&
        input.length <= Number(options[1].maxLength) &&
        expression.test(input)
      );
    for (const input of [
      "TODO", "COLUMN_x", "CUSTOM", "COLUMN_", "COLUMN_\n",
      `COLUMN_${"a".repeat(128)}`, `COLUMN_${"a".repeat(129)}`,
      `COLUMN_${"a".repeat(128)}\n`,
    ]) {
      expect(advertisedAccepts(input)).toBe(outputs.get_task.shape.status.safeParse(input).success);
    }
    expect(jsonSchema(z.string().regex(/^#[0-9a-f]{6}$/)).pattern).toBe("^#[0-9a-f]{6}$");
  });

  it("does not silently discard regexp flags", () => {
    expect(() => jsonSchema(z.string().regex(/x/i))).toThrow();
  });
  it("advertises parsed output defaults and strict nested DTO structure", () => {
    const schema = jsonSchema(outputs.get_task, "output");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toContain("createdById");
    const attachment = property(schema, "attachments").items as Record<string, unknown>;
    expect(attachment.additionalProperties).toBe(false);
    expect(attachment.required).toEqual(expect.arrayContaining(["width", "height"]));
    const input = jsonSchema(inputs.list_tasks, "input");
    expect(input.additionalProperties).toBe(false);
    expect(input.required).not.toContain("page");
    expect(input.required).not.toContain("limit");
  });
});
