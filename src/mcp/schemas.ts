import { z } from "zod";

const id = z.string().min(1).max(128);
const integer = z.number().int().nonnegative();
const version = integer.max(2147483647);
const date = z.string().datetime({ offset: true });
const status = z.enum(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]);
const priority = z.enum(["CRITICAL", "URGENT", "HIGH", "MEDIUM", "LOW"]);
// Output only: the common column constructor preserves COLUMN_<nonempty id>.
// Keep list filter input on the four statuses accepted by the canonical API.
const outputStatus = z.union([status, z.string().min(8).max(135).regex(/^COLUMN_[\s\S]+$/)]);
const limit = z.number().int().min(1).max(100).default(50);
const cursor = z.string().min(1).max(2048).optional();
const operationId = z.string().uuid();
const changes = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(50000).nullable().optional(),
  priority: priority.optional(), deadline: date.nullable().optional(),
}).strict().refine(value => Object.keys(value).length > 0);

export const inputs = {
  list_boards: z.object({ query: z.string().min(1).max(120).optional(), limit, cursor }).strict(),
  get_board: z.object({ projectId: id }).strict(),
  list_tasks: z.object({ projectId: id, status: status.optional(), columnId: id.optional(),
    assignedToMe: z.boolean().optional(), search: z.string().min(1).max(200).optional(),
    page: z.number().int().min(1).default(1), limit }).strict(),
  get_task: z.object({ taskId: id }).strict(),
  list_task_messages: z.object({ taskId: id, cursor, limit }).strict(),
  get_task_history: z.object({ taskId: id }).strict(),
  create_task: z.object({ projectId: id, columnId: id.optional(), title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(50000).optional(), priority: priority.optional(), operationId }).strict(),
  update_task: z.object({ taskId: id, operationId, expectedVersion: version, changes }).strict(),
  add_task_comment: z.object({ taskId: id, operationId, expectedVersion: version, contentText: z.string().trim().min(1).max(20000) }).strict(),
  move_task: z.object({ taskId: id, toColumnId: id, beforeTaskId: id.nullable().default(null),
    afterTaskId: id.nullable().default(null), operationId, expectedVersion: version }).strict(),
};
export type ToolName = keyof typeof inputs;
export type Arguments = { [K in ToolName]: z.infer<(typeof inputs)[K]> };
const color = z.string().regex(/^#[a-fA-F0-9]{6}$/);
const attachment = z.object({ url: z.string(), name: z.string(), size: integer, mime: z.string(),
  width: integer.nullable().default(null), height: integer.nullable().default(null) });
const summary = z.object({ id, title: z.string(), status: outputStatus, priority, columnId: id, projectId: id,
  deadline: date.nullable(), version, updatedAt: date, assigneeIds: z.array(id) });
const board = z.object({ id, name: z.string(), description: z.string().nullable(), createdAt: date,
  updatedAt: date, taskCount: integer, memberCount: integer });
export const outputs = {
  list_boards: z.object({ items: z.array(board.omit({ createdAt: true }).extend({ memberCount: integer.nullable() })),
    nextCursor: z.string().nullable(), hasMore: z.boolean() }),
  get_board: z.object({ board, columns: z.array(z.object({ id, name: z.string(), color, position: z.number().int(),
    workflowKey: z.string(), status: outputStatus })) }),
  list_tasks: z.object({ items: z.array(summary), page: integer, limit: integer, hasMore: z.boolean() }),
  get_task: summary.omit({ assigneeIds: true }).extend({ description: z.string().nullable(),
    position: z.number().int(), createdById: id.nullable().default(null), createdAt: date,
    attachments: z.array(attachment), assignees: z.array(z.object({ id, userId: id, name: z.string().nullable(), avatarUrl: z.string().nullable() })),
    tags: z.array(z.object({ id, name: z.string(), color })),
    checklistItems: z.array(z.object({ id, text: z.string(), completed: z.boolean(), position: z.number().int() })) }),
  list_task_messages: z.object({ items: z.array(z.object({ id, authorId: id, contentText: z.string(),
    attachments: z.array(attachment.omit({ width: true, height: true })), createdAt: date })), nextCursor: z.string().nullable() }),
  get_task_history: z.object({ items: z.array(z.object({ id, action: z.string(), userId: id,
    oldValue: z.record(z.string(), z.unknown()).nullable(), newValue: z.record(z.string(), z.unknown()).nullable(), createdAt: date })),
    limit: z.literal(50), truncated: z.boolean() }),
  create_task: z.object({ taskId: id, projectId: id, version: z.literal(0), replayed: z.boolean() }),
  update_task: z.object({ taskId: id, projectId: id, version, changed: z.boolean(), replayed: z.boolean() }),
  add_task_comment: z.object({ messageId: id, taskId: id, createdAt: date, replayed: z.boolean() }),
  move_task: z.object({ operationId, boardRevision: integer,
    task: z.object({ id, columnId: id, version, status: outputStatus }) }),
};

// JSON Schema is generated from the same Zod trees; refinements stay enforced at runtime.
export function jsonSchema(schema: z.ZodTypeAny, io: "input" | "output" = "input"): Record<string, unknown> {
  const result = z.toJSONSchema(schema, {
    target: "draft-7", io,
    override: ({ zodSchema }) => {
      // JSON Schema has no regexp flags; do not advertise a different language.
      for (const check of zodSchema._zod.def.checks ?? []) {
        const def = check._zod.def;
        if (def.check === "string_format" && "format" in def && def.format === "regex" && "pattern" in def
          && def.pattern instanceof RegExp && def.pattern.flags) {
          throw new Error("Unsupported JSON Schema regular expression flags");
        }
      }
    },
  });
  delete result.$schema;
  return result;
}
