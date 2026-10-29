import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { createProjectSchema } from "@/lib/validators";
import { apiLogger } from "@/lib/logger";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import { isGlobalAdmin } from "@/lib/require-user";
import {
  apiSuccess,
  apiUnauthorized,
  apiBadRequest,
  apiForbidden,
  apiNotFound,
  apiInvalidJson,
  apiInternalError
} from "@/lib/api-response";
import { projectTemplateAvailabilitySchema } from "./template-availability";
import { readProjectTemplates } from "@/lib/project-template-loader";
import { SUPPORT_TEMPLATE_ID } from "@/lib/project-template-catalog";

const saveProjectTemplateSchema = createProjectSchema.extend({
  projectId: z.string().trim().min(1),
  availability: projectTemplateAvailabilitySchema.optional(),
});

function reportFailure(event: string) {
  try {
    apiLogger.error({ event, route: "/api/project-templates" });
  } catch { /* Diagnostics must not replace the safe response. */ }
}

export async function GET(request: Request) {
  try {
    const user = await requireApiUser(request);

    // Administrators see their own templates plus the ones explicitly shared
    // with the organization. Everybody else keeps the existing own-only list.
    const where = isGlobalAdmin(user)
      ? {
          OR: [
            { createdById: user.id },
            { templateData: { path: ["availability"], equals: "organization" } },
          ],
        }
      : { createdById: user.id };

    const templates = await prisma.projectTemplate.findMany({
      where: { AND: [{ id: SUPPORT_TEMPLATE_ID }, where] },
      orderBy: { createdAt: "desc" },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    // The catalog works before a seed run and never offers retired stored rows.
    const [support] = await readProjectTemplates();
    return apiSuccess([{ ...templates.find(template => template.id === SUPPORT_TEMPLATE_ID), ...support }]);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    reportFailure("project.template.list.failed");
    return apiInternalError("Не удалось загрузить шаблоны проектов");
  }
}

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return apiInvalidJson();
  }

  try {
    const user = await requireApiUser(request);
    const parsed = saveProjectTemplateSchema.safeParse(json);
    if (!parsed.success) {
      return apiBadRequest("Некорректные данные шаблона проекта");
    }
    const { name, description, projectId } = parsed.data;
    const availability = parsed.data.availability ?? "creator";

    // Check if user has access to this project
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        OR: [
          { ownerId: user.id },
          { members: { some: { userId: user.id } } },
        ],
      },
      include: {
        columns: {
          orderBy: { position: "asc" },
          select: {
            name: true,
            color: true,
            position: true,
            workflowKey: true,
          },
        },
        tags: {
          select: {
            name: true,
            color: true,
          },
        },
      },
    });

    if (!project && !isGlobalAdmin(user)) {
      return apiForbidden("Нет доступа к проекту");
    }

    if (!project) {
      return apiNotFound("Проект не найден");
    }

    // Build template data. Only structural fields and the explicit
    // availability are snapshotted: no members, privileges, cards or secrets.
    const templateData = {
      columns: project.columns,
      tags: project.tags,
      availability,
    };

    const template = await prisma.projectTemplate.create({
      data: {
        name,
        description: description ?? null,
        templateData,
        createdById: user.id,
      },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    return apiSuccess(template, undefined, 201);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    reportFailure("project.template.create.failed");
    return apiInternalError("Не удалось создать шаблон проекта");
  }
}
