import { z } from "zod";
import { requestDetailsSchema } from "./request-presentation";

export const taskStatusSchema = z.enum(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"]);
export const taskPrioritySchema = z.enum(["CRITICAL", "URGENT", "HIGH", "MEDIUM", "LOW"]);

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(10_000).nullable().optional(),
});

export const createTaskSchema = z.object({
  requestDetails: requestDetailsSchema.optional(),
  audience: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("DEPARTMENT"), userIds: z.tuple([]) }).strict(),
    z.object({ mode: z.literal("SELECTED"), userIds: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)).min(1).max(20).refine(ids => new Set(ids).size === ids.length, "Выберите каждого сотрудника только один раз") }).strict(),
  ]).optional(),
  title: z.string().trim().min(1, "Название обязательно").max(200),
  description: z.string().trim().max(50_000).nullable().optional(),
  status: taskStatusSchema.optional(), // Validated enum
  priority: taskPrioritySchema.optional(),
  projectId: z.string().trim().min(1),
  columnId: z.string().optional(), // New field for dynamic columns
  deadline: z.coerce.date().nullable().optional(),
}).superRefine((input, context) => {
  if (input.requestDetails && !input.audience) context.addIssue({ code: "custom", path: ["audience"], message: "Выберите, кому отправить обращение" });
});

export const patchTaskSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(50_000).nullable().optional(),
    status: taskStatusSchema.optional(), // Validated enum
    priority: taskPrioritySchema.optional(),
    position: z.number().int().optional(),
    deadline: z.coerce.date().nullable().optional(),
    columnId: z.string().optional(), // Added for dynamic column support
    expectedVersion: z.number().int().min(0).optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, "Тело PATCH не может быть пустым");

function actualDeadline(value: string): boolean {
  const date = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
  if (!date) return false;
  const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && Number.isFinite(Date.parse(value));
}

export const taskDetailsCommandSchema = z.object({
  operationId: z.string().uuid(),
  expectedVersion: z.number().int().min(0).max(2147483647),
  changes: z.object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(50_000).nullable().optional(),
    priority: taskPrioritySchema.optional(),
    deadline: z.string().datetime({ offset: true }).refine(actualDeadline, "Invalid deadline").nullable().optional(),
  }).strict().refine(value => Object.values(value).some(item => item !== undefined), "Changes are required"),
}).strict();
export type TaskDetailsCommand = z.infer<typeof taskDetailsCommandSchema>;

export const createCommentSchema = z.object({
  content: z.string().trim().min(1).max(10_000),
  authorId: z.string().trim().min(1).optional(),
});

export function zodErrorToResponse(error: z.ZodError) {
  return {
    error: "ValidationError",
    issues: error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
      code: i.code,
    })),
  };
}

export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof patchTaskSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateCommentInput = z.infer<typeof createCommentSchema>;
