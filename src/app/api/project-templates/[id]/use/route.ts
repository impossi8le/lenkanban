import { prisma } from "@/lib/prisma";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { apiLogger } from "@/lib/logger";
import { rateLimitOrThrowKey, rateLimitErrorResponse } from "@/lib/rate-limit";
import { workflowKeyForTemplateColumn } from "@/features/kanban/server/move-contract";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { isGlobalAdmin } from "@/lib/require-user";
import { ValidationError } from "@/lib/errors";
import {
  apiSuccess,
  apiUnauthorized,
  apiBadRequest,
  apiNotFound,
  apiForbidden,
  apiInvalidJson,
  apiInternalError
} from "@/lib/api-response";
import {
  createBoard,
  parseBoardAccessProfile,
  templateBoardCreationSchema,
} from "@/app/api/projects/board-creation";
import { canUseProjectTemplate } from "../../template-availability";
import { readProjectTemplates } from "@/lib/project-template-loader";
import { SUPPORT_TEMPLATE_ID } from "@/lib/project-template-catalog";

const storedProjectTemplateSchema = z.object({
  descriptionHint: z.string().max(10_000).optional(),
  columns: z.array(z.object({
    key: z.string().optional(),
    name: z.string(),
    color: z.string(),
    position: z.number().int().min(-2147483648).max(2147483647),
    workflowKey: z.string().optional(),
  })).optional(),
  tags: z.array(z.object({ name: z.string(), color: z.string() })).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return apiInvalidJson();
  }

  try {
    const user = await requireApiUser(request);
    if (!isGlobalAdmin(user)) {
      return apiForbidden("Создавать доски могут только глобальные администраторы");
    }
    const { id } = await params;
    const parsed = templateBoardCreationSchema.safeParse(json);
    if (!parsed.success) {
      return apiBadRequest("Некорректные данные проекта");
    }
    const { projectName, projectDescription, departmentId } = parsed.data;

    let accessProfile;
    try {
      accessProfile = parseBoardAccessProfile(parsed.data.accessProfile);
    } catch {
      return apiBadRequest("Некорректный профиль доступа");
    }

    const storedTemplate = await prisma.projectTemplate.findUnique({
      where: { id },
    });
    const template = id === SUPPORT_TEMPLATE_ID
      ? { ...(await readProjectTemplates())[0], createdById: user.id }
      : storedTemplate;

    if (!template) {
      return apiNotFound("Шаблон проекта не найден");
    }

    // The template's creator always may use it; everybody else only when the
    // creator explicitly shared it with the organization.
    if (!canUseProjectTemplate(template, user.id)) {
      return apiForbidden("Нет доступа");
    }

    const stored = storedProjectTemplateSchema.safeParse(template.templateData);
    if (!stored.success) {
      return apiBadRequest("Некорректные данные шаблона проекта");
    }

    const columns = (stored.data.columns ?? []).map((col) => {
      const columnId = randomUUID();
      return {
        id: columnId,
        name: col.name,
        color: col.color,
        position: col.position,
        workflowKey: workflowKeyForTemplateColumn({
          storedWorkflowKey: col.workflowKey,
          name: col.name,
          columnId,
        }),
      };
    });
    const tags = stored.data.tags ?? [];
    if (
      new Set(columns.map(col => col.position)).size !== columns.length ||
      new Set(columns.map(col => col.workflowKey)).size !== columns.length ||
      new Set(tags.map(tag => tag.name)).size !== tags.length
    ) {
      return apiBadRequest("Некорректные данные шаблона проекта");
    }

    try {
      await rateLimitOrThrowKey("projects:create", user.id);
    } catch (error) {
      if (typeof error === "object" && error !== null && "status" in error && error.status === 429) {
        return rateLimitErrorResponse(error);
      }
      throw error;
    }

    // Only the bundled support template's semantic provenance enables mapping.
    // Never infer roles for user templates from display names or positions.
    const columnFor = (key: string) => columns[stored.data.columns?.findIndex(column => column.key === key) ?? -1]?.id;
    const supportIds = id === SUPPORT_TEMPLATE_ID ? ["new", "in-progress", "waiting", "resolved", "closed"].map(columnFor) : [];
    if (id === SUPPORT_TEMPLATE_ID && supportIds.some(value => !value)) return apiBadRequest("Некорректные данные шаблона проекта");
    const lifecycleColumnMap = id === SUPPORT_TEMPLATE_ID ? { contractVersion: 1 as const,
      submittedColumnId: supportIds[0]!, inProgressColumnId: supportIds[1]!, needsInfoColumnId: supportIds[2]!, completedColumnId: supportIds[3]!, closedColumnId: supportIds[4]!,
    } : undefined;
    const project = await createBoard({
      ...(lifecycleColumnMap ? { lifecycleColumnMap } : {}),
      actorId: user.id,
      name: projectName,
      description: !projectDescription && stored.data.descriptionHint
        ? stored.data.descriptionHint
        : projectDescription ?? null,
      departmentId: departmentId ?? null,
      accessProfile,
      columns,
      tags,
    });

    return apiSuccess(project, undefined, 201);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    if (error instanceof ValidationError) {
      return apiBadRequest("Некорректные данные шаблона проекта");
    }
    try {
      apiLogger.error({ event: "project.template.use.failed", route: "/api/project-templates/:id/use" });
    } catch { /* Diagnostics must not replace the safe response. */ }
    return apiInternalError("Не удалось создать проект из шаблона");
  }
}
