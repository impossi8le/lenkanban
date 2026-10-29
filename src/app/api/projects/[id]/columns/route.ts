import { prisma } from "@/lib/prisma";
import { getProjectReadWhere } from "@/lib/project-access";
import { z } from "zod";
import { requireApiUser } from "@/lib/require-api-user";
import { emitColumnCreated } from "@/socket/board-events";
import { randomUUID } from "node:crypto";
import { createOrganizationService } from "@/lib/organization";
import { organizationApi, organizationJson, organizationQuery } from "@/lib/organization-api";
import { ORGANIZATION_STATE_ID } from "@/lib/organization-command";
import { decodeLifecycleColumnMap, lifecycleColumnMapSchema } from "@/lib/task-request-columns";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import {
  defaultWorkflowKey,
  derivedTaskStatus,
} from "@/features/kanban/server/move-contract";
import {
  apiSuccess,
  apiUnauthorized,
  apiNotFound,
  apiValidationError,
  apiInternalError
} from "@/lib/api-response";

const createColumnSchema = z.object({
  name: z.string().min(1).max(50),
  color: z.string().regex(/^#[0-9A-F]{6}$/i, "Неверный hex-цвет"),
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (new URL(request.url).searchParams.has("lifecycle")) {
    return organizationApi(request, "/api/projects/:id/columns", async actorId => {
      const query = organizationQuery(request, ["lifecycle"]);
      if (query.get("lifecycle") !== "1") throw new ValidationError();
      const { id } = await params;
      return prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actorId} FOR SHARE`;
        const actor = await tx.user.findUnique({ where: { id: actorId }, select: { globalRole: true } });
        if (actor?.globalRole !== "ADMIN") throw new ForbiddenError();
        const project = await tx.project.findUnique({ where: { id }, select: { lifecycleColumnMap: true } });
        if (!project) throw new NotFoundError();
        const state = await tx.organizationState.findUnique({ where: { id: ORGANIZATION_STATE_ID } });
        return apiSuccess({ lifecycleColumnMap: decodeLifecycleColumnMap(project.lifecycleColumnMap), version: state?.version ?? 0 });
      });
    });
  }
  try {
    const user = await requireApiUser(request);
    const { id: projectId } = await params;

    // Check project access
    if (user.globalRole !== "ADMIN") {
      const project = await prisma.project.findFirst({
        where: { AND: [{ id: projectId }, await getProjectReadWhere(user)] },
        select: { id: true },
      });
      if (!project) {
        return apiNotFound();
      }
    }

    const columns = await prisma.projectColumn.findMany({
      where: { projectId },
      orderBy: { position: "asc" },
    });

    const columnsWithStatus = columns.map((col) => ({
      ...col,
      status: derivedTaskStatus(col.workflowKey),
    }));

    return apiSuccess(columnsWithStatus);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return apiUnauthorized();
    }
    return apiInternalError("Не удалось загрузить колонки");
  }
}

const lifecycleConfigurationSchema = z.object({ operationId: z.string().uuid(), expectedVersion: z.number().int().min(0).max(2147483647), lifecycleColumnMap: lifecycleColumnMapSchema.nullable() }).strict();

export function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return organizationApi(request, "/api/projects/:id/columns", async actorId => {
    organizationQuery(request, []);
    const body = lifecycleConfigurationSchema.safeParse(await organizationJson(request));
    if (!body.success) throw new ValidationError();
    return apiSuccess(await createOrganizationService(prisma).setProjectLifecycleColumns({ actorId, projectId: (await params).id, ...body.data }));
  }, true);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireApiUser(request);
    const { id: projectId } = await params;
    const body = await request.json();
    const parsed = createColumnSchema.parse(body);

    // Check project access - only owner or PROJECT_ADMIN can create columns
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        OR: [
          { ownerId: user.id },
          { members: { some: { userId: user.id, role: "PROJECT_ADMIN" } } },
        ],
      },
      select: { id: true },
    });

    if (!project && user.globalRole !== "ADMIN") {
      return apiUnauthorized();
    }

    // Get the next position
    const maxPosition = await prisma.projectColumn.findFirst({
      where: { projectId },
      orderBy: { position: "desc" },
      select: { position: true },
    });

    const nextPosition = maxPosition ? maxPosition.position + 1 : 0;

    const columnId = randomUUID();
    const column = await prisma.projectColumn.create({
      data: {
        id: columnId,
        projectId,
        name: parsed.name,
        color: parsed.color,
        position: nextPosition,
        workflowKey: defaultWorkflowKey(4, columnId),
      },
    });

    emitColumnCreated(projectId, column, user.id);

    return apiSuccess(column, undefined, 201);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return apiValidationError(error);
    }
    if (error instanceof Error && error.message === "Unauthorized") {
      return apiUnauthorized();
    }
    return apiInternalError("Не удалось создать колонку");
  }
}
