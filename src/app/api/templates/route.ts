import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { apiLogger } from "@/lib/logger";
import { requireApiUser, UnauthorizedError } from "@/lib/require-api-user";
import {
  apiSuccess,
  apiUnauthorized,
  apiBadRequest,
  apiForbidden,
  apiInvalidJson,
  apiInternalError
} from "@/lib/api-response";

export async function GET(request: Request) {
  try {
    const user = await requireApiUser(request);
    const { searchParams } = new URL(request.url);
    const projectId = searchParams.get("projectId");

    if (!projectId) {
      return apiBadRequest("projectId is required");
    }

    // Check if user has access to this project
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        OR: [
          { ownerId: user.id },
          { members: { some: { userId: user.id } } },
        ],
      },
    });

    if (!project && user.globalRole !== "ADMIN") {
      return apiForbidden("Access denied");
    }

    const templates = await prisma.taskTemplate.findMany({
      where: { projectId },
      include: {
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return apiSuccess(templates);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return apiUnauthorized();
    }
    try {
      apiLogger.error({ event: "api.request.failed", route: "/api/templates", method: "GET", statusCode: 500 });
    } catch { /* Diagnostics cannot replace the safe API response. */ }
    return apiInternalError("Failed to fetch templates");
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
    const body = json as {
      projectId?: string;
      name?: string;
      description?: string | null;
      templateTitle?: string;
      templateDescription?: string | null;
      priority?: string;
      tags?: Prisma.InputJsonValue;
      checklistItems?: Prisma.InputJsonValue;
      estimatedDuration?: number | null;
    };

    const {
      projectId,
      name,
      description,
      templateTitle,
      templateDescription,
      priority,
      tags,
      checklistItems,
      estimatedDuration,
    } = body;

    if (!projectId || !name || !templateTitle) {
      return apiBadRequest("Missing required fields");
    }

    // Check if user has access to this project
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        OR: [
          { ownerId: user.id },
          { members: { some: { userId: user.id } } },
        ],
      },
    });

    if (!project && user.globalRole !== "ADMIN") {
      return apiForbidden("Access denied");
    }

    const template = await prisma.taskTemplate.create({
      data: {
        projectId,
        name,
        description: description || null,
        templateTitle,
        templateDescription: templateDescription || null,
        priority: priority || "MEDIUM",
        tags: tags || [],
        checklistItems: checklistItems || [],
        estimatedDuration: estimatedDuration || null,
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
    try {
      apiLogger.error({ event: "api.request.failed", route: "/api/templates", method: "POST", statusCode: 500 });
    } catch { /* Diagnostics cannot replace the safe API response. */ }
    return apiInternalError("Failed to create template");
  }
}
